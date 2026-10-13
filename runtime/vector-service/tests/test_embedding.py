from pathlib import Path
import socket
import numpy as np
import pytest
from embedding import Embedding

def test_missing_local_model_does_not_download_or_return_fake_vectors(tmp_path):
    with pytest.raises(ValueError):
        Embedding(tmp_path)

@pytest.mark.model
def test_real_bge_is_local_512_dimensional_and_normalized(monkeypatch):
    model = Path(__file__).resolve().parents[3] / '.local/models/bge-small-zh-v1.5'
    if not (model / 'dooknow-model-manifest.json').exists():
        pytest.skip('real local model has not been explicitly prepared')
    def offline(*args, **kwargs):
        raise AssertionError('runtime attempted an external network connection')
    monkeypatch.setattr(socket, 'create_connection', offline)
    engine = Embedding(model)
    vectors = engine.documents(['中文知识库采用 Markdown 整理笔记。', '厨房里的炒锅用于烹饪食物。'])
    query = engine.query('知识库如何整理笔记')
    assert vectors.shape == (2, 512)
    assert query.shape == (512,)
    assert np.allclose(np.linalg.norm(vectors, axis=1), 1, atol=1e-5)
    assert np.isclose(np.linalg.norm(query), 1, atol=1e-5)
    assert float(vectors[0] @ query) > float(vectors[1] @ query)
