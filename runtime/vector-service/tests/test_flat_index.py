import hashlib
import json
import numpy as np
import pytest
from flat_index import FlatIndex, normalize

def test_exact_topk_filters_and_space_validation(tmp_path):
    vectors = np.array([[1, 0], [0, 1], [-1, 0], [.8, .6]], dtype='<f4')
    file = tmp_path / 'segment.f32'
    file.write_bytes(vectors.tobytes())
    manifest = {'generation': 'g1', 'embeddingSpaceId': 'known-space', 'dimensions': 2, 'segments': [{'file': 'segment.f32', 'checksum': hashlib.sha256(file.read_bytes()).hexdigest(), 'rows': [{'chunkId': f'c{i}'} for i in range(4)]}]}
    path = tmp_path / 'manifest.json'
    path.write_text(json.dumps(manifest))
    index = FlatIndex(tmp_path)
    index.load(path, 'known-space')
    result = index.search('g1', normalize([1, 0], 2), 'known-space', [0, 3], 2)
    assert [item['chunkId'] for item in result] == ['c0', 'c3']
    assert [item['row'] for item in index.search('g1', [1, 0], 'known-space', [1, 2], 2)] == [1, 2]
    with pytest.raises(ValueError):
        index.search('g1', [1, 0], 'wrong-space', [0], 1)
    file.write_bytes(b'corrupted')
    with pytest.raises(ValueError):
        FlatIndex(tmp_path).load(path, 'known-space')

@pytest.mark.parametrize('vector', [[0, 0], [float('nan'), 1], [float('inf'), 1], [1, 2, 3]])
def test_invalid_vectors_are_rejected(vector):
    with pytest.raises(ValueError):
        normalize(vector, 2)
