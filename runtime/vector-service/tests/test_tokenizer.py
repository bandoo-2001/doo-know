from pathlib import Path
import pytest
from tokenizer import tokenize, ModelTokenizer

def test_chinese_and_code_identifier_terms_are_preserved():
    terms = tokenize('中文全文检索与 embedding_space_id 和 RRF 融合')
    assert {'中文', '全文', '检索', 'embedding_space_id', 'rrf'}.issubset(set(terms))

def test_token_budget_and_utf8_offsets_cover_the_complete_input():
    model = Path(__file__).resolve().parents[3] / '.local/models/bge-small-zh-v1.5'
    if not (model / 'tokenizer.json').exists():
        pytest.skip('model tokenizer has not been explicitly prepared')
    tokenizer = ModelTokenizer(model)
    source = ('中文😀\r\nembedding_space_id\n' * 180) + '尾部'
    slices = tokenizer.split(source, max_tokens=320, overlap=48)
    original = source.encode('utf-8')
    end = 0
    for item in slices:
        assert item['startByte'] <= end
        assert item['endByte'] > end
        assert item['content'].encode('utf-8') == original[item['startByte']:item['endByte']]
        assert item['tokenCount'] <= 320
        assert len(item['content'].encode('utf-8')) <= 4096
        end = item['endByte']
    assert end == len(original)

def test_unbroken_unknown_word_cannot_bypass_byte_budget_or_stall_overlap():
    model = Path(__file__).resolve().parents[3] / '.local/models/bge-small-zh-v1.5'
    if not (model / 'tokenizer.json').exists():
        pytest.skip('model tokenizer has not been explicitly prepared')
    slices = ModelTokenizer(model).split('x' * 16000)
    assert len(slices) >= 4
    assert slices[-1]['endByte'] == 16000
    assert all(len(item['content'].encode()) <= 4096 for item in slices)
