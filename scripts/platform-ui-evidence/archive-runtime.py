"""Archive and independently restore the full, unmodified browser evidence tree."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile

root = Path("docs/design/platform-unification-2026-11-05/runtime")
parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
archive = args.output.resolve()
manifest = root / "runtime-artifacts.json"
if archive.is_relative_to(Path.cwd()) or manifest.exists():
    raise SystemExit("Choose a fresh external artifact and keep existing manifests intact")
archive.parent.mkdir(parents=True, exist_ok=True)


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


entries = {}
for path in sorted(root.rglob("*")):
    if path.is_symlink():
        raise SystemExit(f"Refusing symlink {path}")
    if path.is_file():
        entries[str(path)] = {"bytes": path.stat().st_size, "sha256": digest(path)}

with archive.open("xb") as stream:
    os.fchmod(stream.fileno(), 0o600)
    with tarfile.open(fileobj=stream, mode="w:gz", compresslevel=1) as output:
        for name in entries:
            output.add(name, arcname=name, recursive=False)
with tempfile.TemporaryDirectory(prefix="dooknow-platform-runtime-restore-") as temporary:
    seen = set()
    with tarfile.open(archive, "r:gz") as output:
        for member in output:
            if not member.isfile() or member.name not in entries or member.name in seen:
                raise ValueError(f"Unexpected archive member {member.name}")
            target = Path(temporary) / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with output.extractfile(member) as source, target.open("xb") as restored:
                shutil.copyfileobj(source, restored)
            entry = entries[member.name]
            if target.stat().st_size != entry["bytes"] or digest(target) != entry["sha256"]:
                raise ValueError(f"Restore mismatch: {member.name}")
            seen.add(member.name)
    if seen != entries.keys():
        raise ValueError("Some files were not restored")

report = {"schema": 1, "archive": {"path": str(archive), "bytes": archive.stat().st_size,
    "sha256": digest(archive)}, "pngCount": sum(name.endswith(".png") for name in seen),
    "restoredEveryEntry": True, "restoredFileCount": len(seen), "files": entries}
manifest.write_text(json.dumps(report, ensure_ascii=False, separators=(",",":")) + "\n")
print(json.dumps({k: v for k, v in report.items() if k != "files"}))
