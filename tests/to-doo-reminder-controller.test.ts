import { describe, expect, it, vi } from 'vitest';
import {
  createToDooReminderController,
  reminderIdFromUrl,
  toDooReminderMessage,
} from '../apps/web/to-doo-reminders';
import { readWorkspaceRoute } from '../apps/web/navigation';

const card = (generation = 0) => ({
  event: {
    id: 'rem_1',
    revision: 'r1',
    deliveryGeneration: generation,
    title: '晨间护肤',
    scheduledAt: '2026-10-30T01:00:00Z',
    sourceType: 'task',
    userState: 'unread',
  },
  section: 'tasks',
  taskId: 'task1',
  occurrenceId: 'occurrence1',
  completion: 'task',
});
const feed = (reminders: unknown[] = [card()]) => ({
  reminders,
  missedCount: 0,
  timeZone: 'Asia/Shanghai',
});

describe('workspace reminder controller', () => {
  it('loads independently of the current application and clears read cards on refresh', async () => {
    const request = vi.fn().mockResolvedValueOnce(feed()).mockResolvedValueOnce(feed([]));
    const model = createToDooReminderController(request);
    await model.refresh();
    expect(model.state.cards[0]?.event.title).toBe('晨间护肤');
    await model.refresh();
    expect(model.state.cards).toHaveLength(0);
    expect(request).toHaveBeenCalledWith('/api/to-doo/reminders/pending');
  });
  it('snoozes against the event revision and only shows the next delivery generation', async () => {
    const request = vi.fn().mockResolvedValue(feed());
    const model = createToDooReminderController(request, {
      now: () => new Date('2026-10-30T01:00:00Z'),
    });
    await model.refresh();
    await model.act(model.state.cards[0]!, 'snooze', { minutes: 5 });
    expect(request).toHaveBeenCalledWith(
      '/api/to-doo/reminders/rem_1/action',
      'POST',
      expect.objectContaining({
        action: 'snooze',
        expectedRevision: 'r1',
        until: '2026-10-30T01:05:00.000Z',
      }),
    );
    await model.refresh();
    expect(model.state.cards).toHaveLength(0);
    request.mockResolvedValue(feed([card(1)]));
    await model.refresh();
    expect(model.state.cards).toHaveLength(1);
  });
  it('keeps the same request identity and card after a failed completion, then permits retry', async () => {
    const bodies: any[] = [];
    let fail = true;
    const request = vi.fn(async (_url: string, method?: string, body?: unknown) => {
      if (!method) return feed();
      bodies.push(body);
      if (fail) throw Error('暂时离线');
      return {};
    });
    const model = createToDooReminderController(request);
    await model.refresh();
    const selected = model.state.cards[0]!;
    await model.act(selected, 'complete');
    expect(model.state.cards).toHaveLength(1);
    expect(model.state.error).toContain('暂时离线');
    fail = false;
    await model.act(selected, 'complete');
    expect(bodies[1]).toEqual(bodies[0]);
    expect(model.state.cards).toHaveLength(0);
  });
  it('does not let an earlier feed response resurrect an actioned card', async () => {
    let resolve!: (value: any) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce(feed())
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue({});
    const model = createToDooReminderController(request);
    await model.refresh();
    const selected = model.state.cards[0]!;
    const loading = model.refresh();
    await model.act(selected, 'read');
    resolve(feed());
    await loading;
    expect(model.state.cards).toHaveLength(0);
  });
  it('opens a particular reminder without any navigation and preserves it outside the unread feed', async () => {
    const request = vi.fn(async (url: string) => (url.endsWith('/pending') ? feed([]) : card()));
    const model = createToDooReminderController(request);
    await model.open('rem_1');
    await model.refresh();
    expect(model.state.cards[0]?.occurrenceId).toBe('occurrence1');
    expect(request).toHaveBeenCalledWith('/api/to-doo/reminders/rem_1');
  });
  it('ignores pending responses after workspace disposal', async () => {
    let resolve!: (value: any) => void;
    const model = createToDooReminderController(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const loading = model.refresh();
    model.dispose();
    resolve(feed());
    await loading;
    expect(model.state.cards).toHaveLength(0);
  });
  it('closes an explicitly opened reminder when another tab marks it read', async () => {
    let current = card();
    const request = vi.fn(async (url: string) => (url.endsWith('/pending') ? feed([]) : current));
    const model = createToDooReminderController(request);
    await model.open('rem_1');
    current = { ...current, event: { ...current.event, revision: 'r2', userState: 'read' } };
    await model.refresh();
    expect(model.state.cards).toHaveLength(0);
  });
});

it('validates worker activation messages and only accepts To Doo root links', () => {
  expect(toDooReminderMessage({ type: 'dooknow-to-doo-open-reminder', eventId: 'rem_1' })).toEqual({
    kind: 'open',
    id: 'rem_1',
  });
  expect(
    toDooReminderMessage({ type: 'dooknow-to-doo-open-reminder', eventId: '../private' }),
  ).toEqual({ kind: 'open', id: null });
  expect(toDooReminderMessage({ type: 'dooknow-to-doo-reminder-update' })).toEqual({
    kind: 'update',
  });
  expect(toDooReminderMessage(null)).toBeNull();
  expect(
    reminderIdFromUrl(
      'https://app.example/?view=apps&app=to-doo&reminder=rem_1',
      'https://app.example',
    ),
  ).toBe('rem_1');
  expect(
    reminderIdFromUrl(
      'https://evil.example/?view=apps&app=to-doo&reminder=rem_1',
      'https://app.example',
    ),
  ).toBeNull();
  expect(
    reminderIdFromUrl('https://app.example/blog?reminder=rem_1', 'https://app.example'),
  ).toBeNull();
});

it('keeps notification and exact task occurrence links inside To Doo navigation', () => {
  expect(
    readWorkspaceRoute(
      'https://app.example/?view=apps&app=to-doo&reminder=rem_1&task=task1&occurrence=occurrence1',
    ),
  ).toMatchObject({ reminder: 'rem_1', task: 'task1', occurrence: 'occurrence1' });
  expect(
    readWorkspaceRoute('https://app.example/?note=n1&reminder=rem_1&occurrence=occurrence1'),
  ).not.toHaveProperty('reminder');
});
