import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import hmac
import itertools
import os
from pathlib import Path
from typing import Any
import numpy as np
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from flat_index import FlatIndex, checksum


def create_app(engine, index_root, token):
    if len(token) < 32:
        raise ValueError('RUNTIME_TOKEN_REQUIRED')
    index = FlatIndex(index_root)
    queue = asyncio.PriorityQueue(maxsize=64)
    sequence = itertools.count()
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='embedding')

    async def consumer():
        loop = asyncio.get_running_loop()
        while True:
            _, _, fn, future = await queue.get()
            try:
                if future.cancelled():
                    continue
                result = await loop.run_in_executor(executor, fn)
                if not future.done():
                    future.set_result(result)
            except Exception:
                if not future.done():
                    future.set_exception(ValueError('EMBEDDING_FAILED'))
            finally:
                queue.task_done()

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(consumer())
        try:
            yield
        finally:
            task.cancel()
            executor.shutdown(wait=True, cancel_futures=True)

    app = FastAPI(lifespan=lifespan)
    app.state.index = index

    @app.middleware('http')
    async def guard(request, next_handler):
        if request.url.path != '/health' and not hmac.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + token):
            return JSONResponse({'error': {'code': 'UNAUTHORIZED', 'retryable': False}}, 401)
        if request.headers.get('content-encoding'):
            return JSONResponse({'error': {'code': 'COMPRESSED_REQUEST_NOT_ALLOWED', 'retryable': False}}, 415)
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > 1024 * 1024:
                return JSONResponse({'error': {'code': 'REQUEST_TOO_LARGE', 'retryable': False}}, 413)
            chunks.append(chunk)
        request._body = b''.join(chunks)
        return await next_handler(request)

    @app.exception_handler(ValueError)
    async def invalid(request, error):
        code = str(error) if str(error).isupper() else 'INVALID_INPUT'
        return JSONResponse({'error': {'code': code, 'retryable': code in ['EMBEDDING_FAILED', 'GENERATION_NOT_LOADED']}}, 409)

    @app.exception_handler(RequestValidationError)
    async def validation(request, error):
        return JSONResponse({'error': {'code': 'INVALID_INPUT', 'retryable': False}}, 422)

    @app.exception_handler(TimeoutError)
    async def timeout(request, error):
        return JSONResponse({'error': {'code': 'EMBEDDING_TIMEOUT', 'retryable': True}}, 503)

    def space(value):
        if value != engine.space_id:
            raise ValueError('EMBEDDING_SPACE_MISMATCH')

    async def encode(priority, fn):
        future = asyncio.get_running_loop().create_future()
        try:
            queue.put_nowait((priority, next(sequence), fn, future))
        except asyncio.QueueFull:
            raise ValueError('EMBEDDING_BUSY')
        return await asyncio.wait_for(future, 30)

    @app.get('/health')
    async def health():
        return {'status': 'ok'}

    @app.get('/describe')
    async def describe():
        return {'spaceId': engine.space_id, 'dimensions': engine.dimension, 'backend': 'flat_file'}

    @app.post('/embed/query')
    async def query(body: dict[str, Any]):
        space(body.get('spaceId'))
        if not isinstance(body.get('query'), str) or not body['query'].strip() or len(body['query']) > 512:
            raise ValueError('INVALID_INPUT')
        vector = await encode(0, lambda: engine.query(body['query']))
        return {'spaceId': engine.space_id, 'vector': vector.tolist()}

    @app.post('/embed/documents')
    async def documents(body: dict[str, Any]):
        space(body.get('spaceId'))
        if not isinstance(body.get('texts'), list) or not 1 <= len(body['texts']) <= 16 or any(not isinstance(t, str) or len(t.encode('utf-8')) > 8192 for t in body['texts']):
            raise ValueError('INVALID_INPUT')
        vectors = await encode(1, lambda: engine.documents(body['texts']))
        return {'spaceId': engine.space_id, 'vectors': vectors.tolist()}

    @app.post('/generations/load')
    async def load(body: dict[str, Any]):
        space(body.get('spaceId'))
        manifest = index.safe_path(body['manifestPath'])
        if checksum(manifest) != body['checksum']:
            raise ValueError('MANIFEST_CHECKSUM_MISMATCH')
        rows = await asyncio.to_thread(index.load, manifest, body['spaceId'])
        import json
        generation = json.loads(manifest.read_text())['generation']
        if index.generations[generation]['dimension'] != engine.dimension:
            index.retire(generation)
            raise ValueError('EMBEDDING_SPACE_MISMATCH')
        return {'loaded': True, 'rows': rows}

    @app.post('/vectors/search')
    async def search(body: dict[str, Any]):
        space(body.get('spaceId'))
        generation = index.generations.get(body['generation'])
        if generation is None:
            raise ValueError('GENERATION_NOT_LOADED')
        import base64
        bitmap = np.frombuffer(base64.b64decode(body['allowedRows'], validate=True), dtype=np.uint8)
        mask = np.unpackbits(bitmap, bitorder='little')[:len(generation['rows'])]
        if len(mask) != len(generation['rows']):
            raise ValueError('INVALID_ALLOWED_ROWS')
        result = await asyncio.to_thread(index.search, body['generation'], body['queryVector'], body['spaceId'], np.flatnonzero(mask), min(500, body.get('limit', 50)))
        return {'results': result, 'generation': body['generation']}

    @app.post('/generations/retire')
    async def retire(body: dict[str, Any]):
        index.retire(body['generation'])
        return {'retired': True}

    return app

if __name__ == '__main__':
    import argparse
    import uvicorn
    from embedding import Embedding
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--index-root', required=True)
    parser.add_argument('--token-file', required=True)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=3081)
    args = parser.parse_args()
    key = Path(args.token_file)
    if key.is_symlink() or key.stat().st_mode & 0o077:
        raise ValueError('RUNTIME_TOKEN_PERMISSIONS')
    runtime = create_app(Embedding(args.model_dir), args.index_root, key.read_text().strip())
    uvicorn.run(runtime, host=args.host, port=args.port, access_log=False)
