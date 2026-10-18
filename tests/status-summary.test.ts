import { describe, it, expect } from 'vitest';
import { indexSummary, searchSummary } from '../apps/web/components/settings/status-model';
describe('status summaries preserve uncertainty', () => {
  it('does not report readiness without a runtime response', () => {
    expect(searchSummary(undefined)).toBe('尚未获取搜索能力');
  });
  it('distinguishes text and semantic readiness', () => {
    expect(searchSummary({ tokenizerReady: true, vectorReady: false })).toBe(
      '关键词搜索可用，语义搜索待准备',
    );
  });
  it('prioritizes conflicts and queued work over idle synchronization', () => {
    expect(
      indexSummary({ pending: 4, retrying: 2, failed: 0, conflicts: 0, sync: { status: 'idle' } }),
    ).toBe('正在更新搜索 · 6 项待处理');
    expect(
      indexSummary({ pending: 0, retrying: 0, failed: 0, conflicts: 2, sync: { status: 'idle' } }),
    ).toBe('2 项写入冲突需要核对');
  });
  it('does not call missing or errored index state complete', () => {
    expect(indexSummary(undefined)).toBe('尚未获取索引状态');
    expect(
      indexSummary({
        pending: 0,
        retrying: 0,
        failed: 0,
        conflicts: 0,
        sync: { status: 'idle' },
        error: 'SOURCE_UNAVAILABLE',
      }),
    ).toBe('原文状态需要检查');
  });
});
