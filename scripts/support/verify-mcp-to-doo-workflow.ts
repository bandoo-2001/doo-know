import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

type Call = (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=',
  'base64',
);

/** Write only new, uniquely named fixture entities, then soft-delete those exact IDs. */
export async function verifyMcpToDooWorkflow(
  call: Call,
  prefix: string,
  options: { cleanup: boolean },
) {
  assert.match(prefix, /^[a-zA-Z0-9_-]{1,80}$/);
  let sequence = 0,
    writes = 0,
    cleaned = 0;
  const created: { kind: string; id: string }[] = [];
  const write = async (name: string, args: Record<string, unknown>) => {
    writes++;
    return call(name, { requestId: prefix + '-r' + sequence++, ...args });
  };
  const remember = (kind: string, id: string) => created.push({ kind, id });
  const revision = (receipt: any, kind: string, id: string): string => {
    const value = receipt.changed?.find(
      (item: any) => item.kind === kind && item.id === id,
    )?.revision;
    assert.equal(typeof value, 'string');
    return value;
  };
  const save = async (kind: string, id: string, fields: Record<string, unknown>) => {
    const receipt = await write('save_to_doo_entity', { kind, id, mode: 'create', fields });
    assert(receipt.ids.includes(id));
    remember(kind, id);
    return receipt;
  };
  const read = async (kind: string, id: string, expectedRevision: string) => {
    const result = await call('read_to_doo_entity', { kind, id, expectedRevision });
    assert.equal(result.range.nextOffset, null);
    return JSON.parse(result.content) as Record<string, any>;
  };
  let primaryError: unknown;
  let firstCleanupError: unknown;
  const cleanupErrors: string[] = [];
  try {
    // Reject before creating any fixture entity; requireIdle below closes
    // the race with another client between this read and start_focus.
    const focusState = await call('query_to_doos', { kind: 'focusOverview', limit: 1 });
    const overview = focusState.items?.[0]?.entity;
    if (!overview || !Object.hasOwn(overview, 'active'))
      throw new Error('MCP_WORKFLOW_FOCUS_STATE_INVALID');
    if (overview.active !== null) throw new Error('MCP_WORKFLOW_REQUIRES_IDLE_DATASET');
    const now = new Date(),
      day = now.toISOString().slice(0, 10);
    const start = new Date(now.getTime() - 25 * 60_000).toISOString();
    const root = prefix + '-goal',
      nested = prefix + '-child',
      taskId = prefix + '-task';
    await save('list', root, { name: 'MCP 验收目标', kind: 'goal', icon: '🌱', color: '#4566c6' });
    const child = await save('list', nested, {
      name: 'MCP 验收子清单',
      parentId: root,
      icon: 'dot',
      color: '#23aa88',
    });
    const childValue = await read('list', nested, revision(child, 'list', nested));
    assert.equal(childValue.parentId, root);
    assert.equal(childValue.icon, 'dot');
    assert.equal(childValue.color, '#23aa88');
    await save('task', taskId, { title: 'MCP 验收任务', listId: nested, priority: 'high' });
    await save('focusTopic', prefix + '-topic', { name: 'MCP 验收专注', listId: nested });
    let focus = await write('execute_to_doo_command', {
      action: 'start_focus',
      payload: { mode: 'stopwatch', topicId: prefix + '-topic', at: start, requireIdle: true },
    });
    const focusId = focus.ids[0] as string;
    assert.equal(typeof focusId, 'string');
    remember('focusSession', focusId);
    focus = await write('execute_to_doo_command', {
      action: 'control_focus',
      payload: {
        id: focusId,
        expectedRevision: revision(focus, 'focusSession', focusId),
        operation: 'pause',
        at: new Date(now.getTime() - 20 * 60_000).toISOString(),
      },
    });
    focus = await write('execute_to_doo_command', {
      action: 'control_focus',
      payload: {
        id: focusId,
        expectedRevision: revision(focus, 'focusSession', focusId),
        operation: 'resume',
        at: new Date(now.getTime() - 15 * 60_000).toISOString(),
      },
    });
    focus = await write('execute_to_doo_command', {
      action: 'control_focus',
      payload: {
        id: focusId,
        expectedRevision: revision(focus, 'focusSession', focusId),
        operation: 'finish',
        at: now.toISOString(),
      },
    });
    focus = await write('execute_to_doo_command', {
      action: 'control_focus',
      payload: {
        id: focusId,
        expectedRevision: revision(focus, 'focusSession', focusId),
        operation: 'correct',
        correctedMinutes: 18,
      },
    });
    const focusValue = await read(
      'focusSession',
      focusId,
      revision(focus, 'focusSession', focusId),
    );
    assert.equal(focusValue.status, 'finished');
    assert.equal(focusValue.correctedMinutes, 18);
    const habitId = prefix + '-habit';
    const habit = await save('habit', habitId, {
      name: 'MCP 验收习惯',
      listId: nested,
      startDate: day,
      timeZone: 'UTC',
      goalMode: 'quantity',
      target: 0.8,
      unit: '升',
    });
    for (const amount of [0.1, 0.7]) {
      const entry = await write('execute_to_doo_command', {
        action: 'checkin_habit',
        payload: {
          habitId,
          expectedHabitRevision: revision(habit, 'habit', habitId),
          localDate: day,
          amount,
          sourceSessionId: amount === 0.1 ? focusId : null,
        },
      });
      remember('habitEntry', entry.ids[0]);
    }
    const statistics = await call('query_to_doos', {
      kind: 'statistics',
      listIds: [nested],
      from: day,
      to: day,
      limit: 1,
    });
    assert.equal(statistics.items[0].entity.habitAmount, 0.8);
    const upload = await write('begin_to_doo_anniversary_image', {
      bytes: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    });
    writes++;
    await call('append_mcp_upload', {
      transferId: upload.transferId,
      offset: 0,
      base64: png.toString('base64'),
    });
    const image = await write('finish_to_doo_anniversary_image', {
      transferId: upload.transferId,
      name: 'mcp-verification.png',
      mime: 'image/png',
    });
    const anniversaryId = prefix + '-anniversary';
    const anniversary = await save('anniversary', anniversaryId, {
      name: 'MCP 验收纪念日',
      date: day,
      appearance: {
        style: 'photo',
        palette: 'ocean',
        image: { ...image, x: 35, y: 65, zoom: 1.5 },
      },
    });
    const anniversaryValue = await read(
      'anniversary',
      anniversaryId,
      revision(anniversary, 'anniversary', anniversaryId),
    );
    assert.equal(anniversaryValue.appearance.image.zoom, 1.5);
    assert.equal(anniversaryValue.appearance.image.x, 35);
    const download = await write('read_to_doo_anniversary_image', {
      anniversaryId,
      expectedRevision: revision(anniversary, 'anniversary', anniversaryId),
    });
    const chunk = await call('read_mcp_transfer', { transferId: download.transferId, offset: 0 });
    assert.deepEqual(Buffer.from(chunk.base64, 'base64'), png);
    const reviewId = prefix + '-review';
    const review = await save('review', reviewId, {
      name: 'MCP 验收复盘',
      from: day,
      to: day,
      capturedAt: now.toISOString(),
      content: '由实际安装的 MCP 标准客户端验收创建。',
      listId: nested,
    });
    const reviewValue = await read('review', reviewId, revision(review, 'review', reviewId));
    assert.equal(reviewValue.listId, nested);
  } catch (error) {
    primaryError = error;
  } finally {
    if (options.cleanup)
      for (const item of [...created].reverse()) {
        try {
          const result = await call('query_to_doos', { kind: item.kind, ids: [item.id], limit: 1 });
          const entity = result.items.find((row: any) => row.entity.id === item.id)?.entity;
          if (entity && !entity.deletedAt)
            await write('execute_to_doo_command', {
              action: 'delete_entity',
              payload: {
                kind: item.kind,
                id: item.id,
                expectedRevision: entity.revision,
                // The service includes tombstoned tasks in list deletion. These
                // lists were created by this workflow; only those exact IDs are touched.
                cascade: item.kind === 'list',
              },
            });
          cleaned++;
        } catch (error) {
          firstCleanupError ??= error;
          cleanupErrors.push(item.kind + ':' + item.id);
        }
      }
  }
  if (primaryError || cleanupErrors.length) {
    const localFailure =
      primaryError instanceof Error &&
      ['MCP_WORKFLOW_REQUIRES_IDLE_DATASET', 'MCP_WORKFLOW_FOCUS_STATE_INVALID'].includes(
        primaryError.message,
      )
        ? primaryError.message
        : undefined;
    const failure = new Error(
      localFailure ?? (primaryError ? 'MCP_WORKFLOW_FAILED' : 'MCP_WORKFLOW_CLEANUP_FAILED'),
      { cause: primaryError ?? firstCleanupError },
    );
    Object.assign(failure, {
      writes,
      created: created.length,
      cleaned,
      cleanupErrors,
    });
    throw failure;
  }
  return {
    writes,
    created: created.length,
    cleaned,
    cleanup: options.cleanup
      ? 'soft-deleted fixture entities; immutable blob retained until fixture removal'
      : 'fixture teardown',
    checks: [
      'hierarchical goal/list/icon/color',
      'task create',
      'focus start/pause/resume/finish/correct',
      'habit revision and decimal statistics',
      'anniversary upload/crop/read bytes',
      'review create/read',
    ],
  };
}
