import sys
import socket
import json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from embedding import Embedding
from app import create_app
import uvicorn
engine = Embedding(sys.argv[1])
app = create_app(engine, sys.argv[2], sys.argv[3])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.bind(('127.0.0.1', 0))
print(json.dumps({'port': sock.getsockname()[1], 'spaceId': engine.space_id}), flush=True)
uvicorn.run(app, fd=sock.fileno(), access_log=False, log_level='warning')
