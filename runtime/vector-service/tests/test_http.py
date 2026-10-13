import asyncio
import threading
import numpy as np
import httpx
from fastapi.testclient import TestClient
from app import create_app


TOKEN = 'isolated-vector-http-token-at-least-thirty-two'


class Engine:
    space_id = 'isolated-space'
    dimension = 512

    def query(self, text):
        return np.eye(1, self.dimension, dtype=np.float32)[0]

    def documents(self, texts):
        return np.repeat(self.query('')[None, :], len(texts), axis=0)


def test_bounded_private_http_and_sanitized_invalid_inputs(tmp_path):
    with TestClient(create_app(Engine(), tmp_path, TOKEN), raise_server_exceptions=False) as client:
        assert client.get('/health').json() == {'status': 'ok'}
        assert client.get('/describe').status_code == 401
        headers = {'authorization': 'Bearer ' + TOKEN}
        assert client.get('/describe', headers=headers).json()['dimensions'] == 512
        assert client.post('/embed/query', json={'query': 'private', 'spaceId': 'isolated-space'}, headers={**headers, 'content-encoding': 'gzip'}).status_code == 415
        assert client.post('/embed/query', content=b'x' * (1024 * 1024 + 1), headers=headers).status_code == 413
        for body in [{'spaceId': 'isolated-space'}, {'query': 'private', 'spaceId': 'wrong'}, 'private-validation-sentinel']:
            r = client.post('/embed/query', json=body, headers=headers)
            assert r.status_code in [400, 409, 422]
            assert isinstance(r.json()['error']['code'], str)
            assert 'private-validation-sentinel' not in r.text


def test_query_overtakes_queued_document_batches(tmp_path):
    entered, release = threading.Event(), threading.Event()
    order = []

    class WaitingEngine(Engine):
        def documents(self, texts):
            if texts == ['blocking']:
                entered.set()
                release.wait(5)
            order.append(texts[0])
            return super().documents(texts)

        def query(self, text):
            if text:
                order.append('query')
            return super().query(text)

    async def scenario():
        app = create_app(WaitingEngine(), tmp_path, TOKEN)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test', headers={'authorization': 'Bearer ' + TOKEN}) as client:
                blocked = asyncio.create_task(client.post('/embed/documents', json={'spaceId': 'isolated-space', 'texts': ['blocking']}))
                assert await asyncio.to_thread(entered.wait, 3)
                docs = [asyncio.create_task(client.post('/embed/documents', json={'spaceId': 'isolated-space', 'texts': [f'queued-{i}']})) for i in range(3)]
                await asyncio.sleep(.02)
                query = asyncio.create_task(client.post('/embed/query', json={'spaceId': 'isolated-space', 'query': 'query'}))
                await asyncio.sleep(.02)
                release.set()
                for r in await asyncio.gather(blocked, *docs, query):
                    assert r.status_code == 200
        assert order == ['blocking', 'query', 'queued-0', 'queued-1', 'queued-2']
    asyncio.run(scenario())
