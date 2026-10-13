"""Explicit, pinned public model preparation. Runtime never downloads models."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.request

REPO = 'BAAI/bge-small-zh-v1.5'
REVISION = '7999e1d3359715c523056ef9478215996d62a620'
FILES = ['config.json', 'model.safetensors', 'modules.json', 'config_sentence_transformers.json', 'sentence_bert_config.json', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json', 'vocab.txt', '1_Pooling/config.json']

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(65536), b''):
            h.update(block)
    return h.hexdigest()

def prepare(destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    url = f'https://huggingface.co/api/models/{REPO}/revision/{REVISION}?blobs=true'
    with urllib.request.urlopen(url, timeout=30) as response:
        info = json.load(response)
    if info.get('sha') != REVISION:
        raise RuntimeError('unexpected model revision')
    entries = {item['rfilename']: item for item in info['siblings']}
    checksums = {}
    for name in FILES:
        target = destination / name
        expected = entries[name].get('lfs', {}).get('sha256')
        if target.exists():
            if target.is_symlink() or (expected and digest(target) != expected):
                raise RuntimeError('existing model file does not match pinned source')
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(target.name + f'.{os.getpid()}.tmp')
            try:
                with urllib.request.urlopen(f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}', timeout=120) as source, temporary.open('xb') as out:
                    total = 0
                    for block in iter(lambda: source.read(65536), b''):
                        total += len(block)
                        if total > 512 * 1024 * 1024:
                            raise RuntimeError('model file exceeds preparation budget')
                        out.write(block)
                    out.flush()
                    os.fsync(out.fileno())
                if expected and digest(temporary) != expected:
                    raise RuntimeError('model checksum mismatch')
                temporary.rename(target)
            finally:
                temporary.unlink(missing_ok=True)
        checksums[name] = digest(target)
    manifest = {'model': REPO, 'revision': REVISION, 'sha256': checksums}
    (destination / 'dooknow-model-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2))
    print(json.dumps({'model': REPO, 'revision': REVISION, 'files': len(checksums), 'bytes': sum((destination / name).stat().st_size for name in FILES)}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination')
    prepare(parser.parse_args().destination)
