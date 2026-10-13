"""Bounded local JSON-lines tokenizer independent of embedding service uptime."""
import json
import os
import sys
from tokenizer import ModelTokenizer, tokenize

def main():
    model = ModelTokenizer(os.environ['DOOKNOW_MODEL_DIR'])
    for line in sys.stdin.buffer:
        try:
            if len(line) > 1024 * 1024:
                raise ValueError('TOKENIZER_REQUEST_TOO_LARGE')
            message = json.loads(line)
            method = message['method']
            if method == 'tokenize':
                result = [tokenize(text) for text in message['texts']]
            elif method == 'split':
                result = {'slices': model.split(message['text']), 'header': model.header(message.get('header', '')), 'carryStartByte': model.tail_start_byte(message['text'])}
            elif method == 'count':
                result = [model.count(text) for text in message['texts']]
            else:
                raise ValueError('UNKNOWN_TOKENIZER_OPERATION')
            response = {'id': message['id'], 'data': result}
        except Exception as error:
            response = {'id': message.get('id') if 'message' in locals() else None, 'error': str(error) if isinstance(error, ValueError) else 'TOKENIZER_FAILED'}
        output = json.dumps(response, ensure_ascii=False, separators=(',', ':')).encode()
        if len(output) > 1024 * 1024:
            output = json.dumps({'id': message.get('id'), 'error': 'TOKENIZER_RESPONSE_TOO_LARGE'}).encode()
        sys.stdout.buffer.write(output + b'\n')
        sys.stdout.buffer.flush()

if __name__ == '__main__':
    main()
