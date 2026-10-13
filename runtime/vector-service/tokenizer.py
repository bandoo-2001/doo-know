import bisect
import hashlib
import json
import logging
import re
from pathlib import Path
import jieba
from tokenizers import Tokenizer

jieba.setLogLevel(logging.WARNING)

def tokenize(text):
    if not isinstance(text, str) or len(text.encode('utf-8')) > 65536:
        raise ValueError('TOKENIZER_INPUT_TOO_LARGE')
    terms = {term.strip().lower() for term in jieba.cut_for_search(text) if term.strip()}
    terms.update(match.group(0).lower() for match in re.finditer(r'[A-Za-z_][A-Za-z0-9_]*', text))
    return sorted(terms)

class ModelTokenizer:
    def __init__(self, model):
        model = Path(model)
        if not (model / 'tokenizer.json').is_file():
            raise ValueError('LOCAL_TOKENIZER_MISSING')
        self.encoder = Tokenizer.from_file(str(model / 'tokenizer.json'))
        self.encoder.no_truncation()
        self.encoder.no_padding()
        self.tokenizer_hash = hashlib.sha256((model / 'tokenizer.json').read_bytes()).hexdigest()

    def count(self, text):
        return len(self.encoder.encode(text, add_special_tokens=True).ids)

    def header(self, text, max_tokens=64):
        encoding = self.encoder.encode(text, add_special_tokens=False)
        if len(encoding.ids) <= max_tokens:
            return text
        return text[:encoding.offsets[max_tokens - 1][1]]

    def tail_start_byte(self, text, overlap=48):
        encoded = self.encoder.encode(text, add_special_tokens=False)
        offsets = [(a, b) for a, b in encoded.offsets if b > a]
        start = offsets[max(0, len(offsets) - overlap)][0] if offsets else len(text)
        while start < len(text) and len(text[start:].encode()) > 512:
            start += 1
        return len(text[:start].encode())

    def split(self, text, max_tokens=320, overlap=48, max_bytes=4096):
        if not isinstance(text, str) or len(text.encode('utf-8')) > 65536:
            raise ValueError('TOKENIZER_INPUT_TOO_LARGE')
        if not 1 <= max_tokens <= 510 or not 0 <= overlap < max_tokens:
            raise ValueError('INVALID_TOKEN_BUDGET')
        byte_offsets = [0]
        for character in text:
            byte_offsets.append(byte_offsets[-1] + len(character.encode('utf-8')))
        result, start = [], 0
        while start < len(text):
            remaining = text[start:]
            encoded = self.encoder.encode(remaining, add_special_tokens=False)
            end = len(text) if len(encoded.ids) <= max_tokens else start + encoded.offsets[max_tokens - 1][1]
            end = min(end, bisect.bisect_right(byte_offsets, byte_offsets[start] + max_bytes) - 1)
            if end <= start:
                raise ValueError('TOKENIZER_NO_PROGRESS')
            content = text[start:end]
            actual = self.encoder.encode(content, add_special_tokens=False)
            if len(actual.ids) > max_tokens:
                end = start + actual.offsets[max_tokens - 1][1]
                content = text[start:end]
                actual = self.encoder.encode(content, add_special_tokens=False)
            result.append({'content': content, 'startByte': byte_offsets[start], 'endByte': byte_offsets[end], 'tokenCount': len(actual.ids)})
            if end == len(text):
                break
            offsets = [(a, b) for a, b in actual.offsets if b > a]
            next_start = start + offsets[max(0, len(offsets) - overlap)][0] if offsets and overlap else end
            # Unknown long words can occupy one token spanning the entire chunk.
            # Bound overlap independently and always make forward progress.
            next_start = max(next_start, bisect.bisect_left(byte_offsets, max(byte_offsets[start], byte_offsets[end] - 512)))
            start = next_start if start < next_start < end else end
        return result
