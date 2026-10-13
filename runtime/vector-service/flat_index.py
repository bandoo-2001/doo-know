import hashlib
import json
from pathlib import Path
import numpy as np


def normalize(vector, dimensions):
    array = np.asarray(vector, dtype=np.float32)
    if array.ndim not in (1, 2) or array.shape[-1] != dimensions or not np.isfinite(array).all():
        raise ValueError('INVALID_VECTOR')
    norm = np.linalg.norm(array, axis=-1, keepdims=True)
    if np.any(norm == 0) or not np.isfinite(norm).all():
        raise ValueError('INVALID_VECTOR')
    return np.ascontiguousarray(array / norm, dtype=np.float32)


def checksum(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(65536), b''):
            h.update(block)
    return h.hexdigest()


class FlatIndex:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.generations = {}

    def safe_path(self, path):
        p = Path(path)
        if not p.is_absolute():
            p = self.root / p
        if p.is_symlink() or not p.resolve().is_relative_to(self.root):
            raise ValueError('INVALID_INDEX_PATH')
        return p.resolve()

    def load(self, manifest, space):
        path = self.safe_path(manifest)
        if path.stat().st_size > 64 * 1024 * 1024:
            raise ValueError('MANIFEST_TOO_LARGE')
        data = json.loads(path.read_text())
        if data['embeddingSpaceId'] != space or not 1 <= data['dimensions'] <= 4096:
            raise ValueError('EMBEDDING_SPACE_MISMATCH')
        dimension = data['dimensions']
        matrices, rows = [], []
        for segment in data['segments']:
            file = self.safe_path(segment['file'])
            count = len(segment['rows'])
            physical_count = segment.get('rowCount', count)
            if not isinstance(physical_count, int) or physical_count < count or file.stat().st_size != physical_count * dimension * 4 or checksum(file) != segment['checksum']:
                raise ValueError('INDEX_CORRUPT')
            matrix = np.memmap(file, dtype='<f4', mode='r', shape=(physical_count, dimension)) if physical_count else np.empty((0, dimension), dtype=np.float32)
            selected = np.asarray([row.get('rowIndex', i) for i, row in enumerate(segment['rows'])], dtype=np.int64)
            if len(selected) and (np.any(selected < 0) or np.any(selected >= physical_count) or len(np.unique(selected)) != len(selected)):
                raise ValueError('INDEX_CORRUPT')
            if count != physical_count or (count and not np.array_equal(selected, np.arange(count))):
                matrix = matrix[selected]
            for start in range(0, count, 4096):
                block = matrix[start:start + 4096]
                if not np.isfinite(block).all() or not np.allclose(np.linalg.norm(block, axis=1), 1, atol=1e-3):
                    raise ValueError('INVALID_VECTOR')
            matrices.append(matrix)
            rows.extend(segment['rows'])
        # Build once per generation. Queries never re-parse full JSON or copy a full filtered matrix.
        matrix = np.concatenate(matrices, axis=0) if matrices else np.empty((0, dimension), dtype=np.float32)
        self.generations[data['generation']] = {'space': space, 'dimension': dimension, 'matrix': matrix, 'rows': rows, 'manifest': data}
        return len(rows)

    def search(self, generation, query, space, allowed, limit):
        index = self.generations.get(generation)
        if not index:
            raise ValueError('GENERATION_NOT_LOADED')
        if space != index['space']:
            raise ValueError('EMBEDDING_SPACE_MISMATCH')
        query = normalize(query, index['dimension'])
        if query.ndim != 1:
            raise ValueError('INVALID_VECTOR')
        count = len(index['rows'])
        rows = np.asarray(allowed, dtype=np.int64)
        if rows.ndim != 1 or (len(rows) and (np.any(rows < 0) or np.any(rows >= count))):
            raise ValueError('INVALID_ALLOWED_ROWS')
        rows = np.unique(rows)
        if not len(rows):
            return []
        if len(rows) == count:
            scores = index['matrix'] @ query
        else:
            scores = np.empty(len(rows), dtype=np.float32)
            for start in range(0, len(rows), 4096):
                scores[start:start + 4096] = index['matrix'][rows[start:start + 4096]] @ query
        k = min(max(1, int(limit)), 500, len(rows))
        chosen = np.argpartition(scores, len(scores) - k)[-k:]
        chosen = sorted(chosen, key=lambda i: (-float(scores[i]), int(rows[i])))
        return [{'chunkId': index['rows'][int(rows[i])]['chunkId'], 'row': int(rows[i]), 'rank': rank + 1, 'score': float(scores[i])} for rank, i in enumerate(chosen)]

    def retire(self, generation):
        self.generations.pop(generation, None)
