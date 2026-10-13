import os
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
import hashlib
import json
from pathlib import Path
import numpy as np
from flat_index import normalize, checksum
from tokenizer import ModelTokenizer

QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：'

class Embedding:
    def __init__(self, model):
        model = Path(model).resolve()
        manifest_path = model / 'dooknow-model-manifest.json'
        if not manifest_path.is_file():
            raise ValueError('LOCAL_MODEL_MISSING')
        manifest = json.loads(manifest_path.read_text())
        for name, expected in manifest['sha256'].items():
            file = model / name
            if file.is_symlink() or not file.resolve().is_relative_to(model) or not file.is_file() or checksum(file) != expected:
                raise ValueError('MODEL_CHECKSUM_MISMATCH')
        self.tokenizer = ModelTokenizer(model)
        import torch
        from sentence_transformers import SentenceTransformer
        torch.set_num_threads(int(os.environ.get('DOOKNOW_RUNTIME_THREADS', '2')))
        self.model = SentenceTransformer(str(model), device='cpu', local_files_only=True, trust_remote_code=False)
        self.model.max_seq_length = 512
        self.dimension = self.model.get_embedding_dimension()
        if self.dimension != 512:
            raise ValueError('MODEL_DIMENSION_MISMATCH')
        self.space_id = hashlib.sha256(json.dumps({'manifest': manifest, 'queryInstruction': QUERY_INSTRUCTION, 'pooling': 'cls', 'normalization': 'l2', 'dimension': 512, 'precision': 'float32', 'tokenizer': self.tokenizer.tokenizer_hash}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

    def documents(self, texts):
        if not isinstance(texts, list) or not 1 <= len(texts) <= 16:
            raise ValueError('EMBEDDING_BATCH_LIMIT')
        for text in texts:
            if not isinstance(text, str) or len(text.encode()) > 8192 or self.tokenizer.count(text) > 512:
                raise ValueError('EMBEDDING_TOKEN_LIMIT')
        values = self.model.encode(texts, batch_size=16, convert_to_numpy=True, normalize_embeddings=False, show_progress_bar=False)
        return normalize(values, self.dimension)

    def query(self, text):
        if not isinstance(text, str) or not text.strip() or len(text) > 512:
            raise ValueError('INVALID_QUERY')
        return self.documents([QUERY_INSTRUCTION + text])[0]
