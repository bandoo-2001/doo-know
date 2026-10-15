"""Build a private, hash-locked offline CPython/CPU/model distribution.

Build-time only. Never copies the developer venv or executes cached wheels.
"""
import argparse
import email
import hashlib
import itertools
import json
import re
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PYTHON_URL = 'https://github.com/astral-sh/python-build-standalone/releases/download/20260414/cpython-3.14.4%2B20260414-x86_64-unknown-linux-gnu-install_only.tar.gz'
PYTHON_SHA = 'e17275eaf95ceb5877aa6816e209b7733f41fee401d39c3921b88fb73fc4a4ba'
MODEL_REVISION = '7999e1d3359715c523056ef9478215996d62a620'
MODEL_MANIFEST_SHA = 'd0c67f164fa76600fc586e2fea0f9b5ca7866fc7b78f7486d9ed7e472c017b01'
SPACE = '6fabd979756dff4dc79f1430da4cdff500badfb47db0eb8c0d4b07b02770faf5'
normalize = lambda s: re.sub(r'[-_.]+', '-', s).lower()
def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while block := stream.read(1024 * 1024): h.update(block)
    return h.hexdigest()
def download(url, path, expected):
    if path.exists() and digest(path) == expected: return
    partial = path.with_suffix(path.suffix + '.part')
    with urllib.request.urlopen(url, timeout=60) as response, partial.open('wb') as stream:
        shutil.copyfileobj(response, stream)
    if digest(partial) != expected: raise ValueError('DOWNLOAD_CHECKSUM_MISMATCH')
    partial.replace(path)
def wheel(path):
    try:
        if not zipfile.is_zipfile(path): return
        with zipfile.ZipFile(path) as z:
            metadata = [n for n in z.namelist() if n.endswith('.dist-info/METADATA') and n.count('/') == 1]
            if len(metadata) != 1: return
            base = metadata[0].rsplit('/', 1)[0]
            m = email.message_from_bytes(z.read(metadata[0])); w = email.message_from_bytes(z.read(base + '/WHEEL'))
            tags = {tuple(t.split('-')) for t in w.get_all('Tag', [])}
            if not tags or any(len(t) != 3 for t in tags): return
            columns = [sorted({t[i] for t in tags}) for i in range(3)]
            if set(itertools.product(*columns)) != tags: return
            dist_version = base.removesuffix('.dist-info')
            if normalize(dist_version.rsplit('-', 1)[0]) != normalize(m['Name']): return
            filename = dist_version + ('-' + w['Build'] if w['Build'] else '') + '-' + '-'.join('.'.join(c) for c in columns) + '.whl'
            return {'name': m['Name'], 'version': m['Version'], 'file': filename, 'sha256': digest(path), 'bytes': path.stat().st_size, '_path': path}
    except (zipfile.BadZipFile, ValueError, KeyError, OSError): return

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--output', required=True); parser.add_argument('--base-url', required=True); parser.add_argument('--model-dir', default=str(REPO / '.local/models/bge-small-zh-v1.5')); parser.add_argument('--record-lock', action='store_true')
    args = parser.parse_args(); output = Path(args.output).resolve(); output.mkdir(parents=True, exist_ok=True)
    cache = REPO / '.local/release-inputs'; cache.mkdir(parents=True, exist_ok=True)
    locks = {}
    for line in (REPO / 'runtime/vector-service/requirements.lock.txt').read_text().splitlines():
        name, version = line.split('=='); locks[(normalize(name), version)] = name
    found = {}
    # Read ZIP payloads only; never inspect HTTP headers, origin.json or credentials.
    pipcache = Path.home() / '.cache/pip'
    candidates = list((pipcache / 'http-v2').rglob('*.body')) + list((pipcache / 'wheels').rglob('*.whl')) + list(cache.glob('*.whl'))
    for path in candidates:
        item = wheel(path)
        if item and (normalize(item['name']), item['version']) in locks: found[(normalize(item['name']), item['version'])] = item
    if ('setuptools', '78.1.0') not in found:
        with urllib.request.urlopen('https://pypi.org/pypi/setuptools/78.1.0/json', timeout=30) as response: metadata = json.load(response)
        artifact = next(a for a in metadata['urls'] if a['filename'].endswith('-py3-none-any.whl'))
        path = cache / artifact['filename']; download(artifact['url'], path, artifact['digests']['sha256']); found[('setuptools', '78.1.0')] = wheel(path)
    if set(locks) != set(found): raise ValueError('MISSING_LOCKED_WHEELS: ' + ','.join(n + '==' + v for n, v in set(locks)-set(found)))
    manifest_path = REPO / 'runtime/vector-service/wheels-manifest.json'
    recorded = sorted(({k: v for k, v in item.items() if k != '_path'} for item in found.values()), key=lambda a: normalize(a['name']))
    if not manifest_path.exists():
        if not args.record_lock: raise ValueError('WHEEL_HASH_LOCK_REQUIRED')
        manifest_path.write_text(json.dumps(recorded, indent=2) + '\n')
    expected = json.loads(manifest_path.read_text())
    for item in expected:
        actual = found[(normalize(item['name']), item['version'])]
        if any(actual[k] != item[k] for k in ('sha256','file','bytes')): raise ValueError('WHEEL_HASH_LOCK_MISMATCH: ' + item['name'])
    python = cache / 'cpython-3.14.4-linux-x64.tar.gz'; download(PYTHON_URL, python, PYTHON_SHA)
    model = Path(args.model_dir).resolve(); model_manifest = model / 'dooknow-model-manifest.json'
    if digest(model_manifest) != MODEL_MANIFEST_SHA: raise ValueError('MODEL_MANIFEST_MISMATCH')
    model_info = json.loads(model_manifest.read_text())
    if model_info['revision'] != MODEL_REVISION: raise ValueError('MODEL_REVISION_MISMATCH')
    for name, expected_hash in model_info['sha256'].items():
        path = model / name
        if path.is_symlink() or not path.resolve().is_relative_to(model) or digest(path) != expected_hash: raise ValueError('MODEL_CHECKSUM_MISMATCH')
    with tempfile.TemporaryDirectory(prefix='.search-build-', dir=output) as temp:
        stage = Path(temp); shutil.copyfile(python, stage / 'python.tar.gz'); (stage / 'wheelhouse').mkdir(); (stage / 'model').mkdir()
        for item in expected: shutil.copyfile(found[(normalize(item['name']), item['version'])]['_path'], stage / 'wheelhouse' / item['file'])
        (stage / 'requirements.txt').write_text(''.join(f"{i['name']}=={i['version']} --hash=sha256:{i['sha256']}\n" for i in expected))
        shutil.copyfile(manifest_path, stage / 'wheels-manifest.json')
        for name in [*model_info['sha256'], 'dooknow-model-manifest.json']:
            target = stage / 'model' / name; target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(model / name, target)
        (stage / 'MODEL-SOURCE.txt').write_text('BAAI/bge-small-zh-v1.5\nRevision: ' + MODEL_REVISION + '\nLicense: MIT\nhttps://huggingface.co/BAAI/bge-small-zh-v1.5/blob/' + MODEL_REVISION + '/README.md\n')
        version = 'bge-zh-cpu-20261015'; files = {str(p.relative_to(stage)): digest(p) for p in stage.rglob('*') if p.is_file()}
        info = {'version': version, 'pythonVersion': '3.14.4', 'platform': 'linux-x64', 'spaceId': SPACE, 'modelRevision': MODEL_REVISION, 'files': files}
        (stage / 'bundle.json').write_text(json.dumps(info, indent=2) + '\n')
        filename = 'dooknow-search-' + version + '-linux-x64.tar.gz'; target = output / filename
        with tarfile.open(target.with_suffix('.part'), 'w:gz') as archive:
            for path in sorted(stage.rglob('*')):
                if path.is_file(): archive.add(path, arcname=str(path.relative_to(stage)), recursive=False)
        target.with_suffix('.part').replace(target)
        metadata = {**{k: v for k, v in info.items() if k != 'files'}, 'url': args.base_url.rstrip('/') + '/' + filename, 'sha256': digest(target), 'bytes': target.stat().st_size}
        (output / 'search-runtime.json').write_text(json.dumps(metadata, indent=2) + '\n'); print(json.dumps({'output': str(target), 'bytes': metadata['bytes'], 'sha256': metadata['sha256']}))
if __name__ == '__main__': main()
