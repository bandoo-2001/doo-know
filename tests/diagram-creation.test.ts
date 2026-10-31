import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, type AppDatabase } from '../packages/core/db';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import type { AppConfig } from '../shared/contracts';
import type { Principal } from '../shared/knowledge-contracts';
import { scanFiles } from '../packages/core/files';

let root: string, db: AppDatabase, config: AppConfig;
const principal: Principal = {
  id: 'owner',
  clientId: 'browser',
  scopes: ['knowledge:read', 'knowledge:write'],
  allowedPrefixes: ['00-Inbox'],
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diagram-reservation-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    secret: 'isolated-test-only',
    origin: 'http://localhost',
  };
  mkdirSync(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  db = openDatabase(config.dataRoot);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const input = (path = '00-Inbox/架构.md') => ({
  path,
  type: 'whiteboard' as const,
  requestId: randomUUID(),
});

it('reserves a stable identity without activating a note, source file or index entry', () => {
  const service = diagramCreationService(config, db, principal);
  const request = input(),
    intent = service.reserve(request);
  expect(intent).toMatchObject({
    relativePath: request.path,
    documentType: 'whiteboard',
    status: 'reserved',
  });
  expect(intent.noteId).toMatch(/^[a-f0-9-]{36}$/);
  expect(existsSync(join(config.knowledgeRoot, request.path))).toBe(false);
  expect(scanFiles(config.knowledgeRoot).notes).toEqual([]);
  expect(db.prepare('SELECT count(*) AS count FROM notes').get()).toEqual({ count: 0 });
  expect(db.prepare('SELECT count(*) AS count FROM document_state').get()).toEqual({ count: 0 });
  expect(service.reserve(request)).toEqual(intent);
});

it('binds a request to its exact path/type and prevents another reservation taking the path', () => {
  const service = diagramCreationService(config, db, principal),
    request = input();
  service.reserve(request);
  expect(() => service.reserve({ ...request, type: 'flowchart' })).toThrowError(
    expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
  );
  expect(() => service.reserve(input())).toThrowError(
    expect.objectContaining({ code: 'NAME_CONFLICT' }),
  );
});

it('retains the same reservation after reopening the database', () => {
  const request = input(),
    intent = diagramCreationService(config, db, principal).reserve(request);
  db.close();
  db = openDatabase(config.dataRoot);
  const service = diagramCreationService(config, db, principal);
  expect(service.get(intent.id)).toEqual(intent);
  expect(service.reserve(request)).toEqual(intent);
});

it('checks the current authority on retries and hides intents from other clients', () => {
  const request = input(),
    intent = diagramCreationService(config, db, principal).reserve(request);
  const revoked = diagramCreationService(config, db, {
    ...principal,
    allowedPrefixes: ['30-Knowledge'],
  });
  expect(() => revoked.reserve(request)).toThrowError(expect.objectContaining({ statusCode: 403 }));
  expect(() => revoked.get(intent.id)).toThrowError(expect.objectContaining({ statusCode: 403 }));
  const other = diagramCreationService(config, db, { ...principal, clientId: 'other-client' });
  expect(() => other.get(intent.id)).toThrowError(expect.objectContaining({ statusCode: 404 }));
  expect(() => other.cancel(intent.id)).toThrowError(expect.objectContaining({ statusCode: 404 }));
});

it('cancels idempotently and frees the path without reusing the old request identity', () => {
  const service = diagramCreationService(config, db, principal),
    request = input();
  const intent = service.reserve(request),
    cancelled = service.cancel(intent.id);
  expect(cancelled.status).toBe('cancelled');
  expect(service.cancel(intent.id)).toEqual(cancelled);
  expect(service.reserve(request).status).toBe('cancelled');
  expect(service.reserve(input()).noteId).not.toBe(intent.noteId);
});

it('expires the preparation lease and frees the path while keeping the old terminal receipt', () => {
  const service = diagramCreationService(config, db, principal),
    request = input();
  const intent = service.reserve(request);
  db.prepare('UPDATE diagram_creation_intents SET expires_at=1 WHERE id=?').run(intent.id);
  expect(service.get(intent.id).status).toBe('expired');
  expect(service.reserve(request).status).toBe('expired');
  expect(service.reserve(input()).noteId).not.toBe(intent.noteId);
});

it('refuses existing files, unsupported types and unsafe or non-Markdown destinations', () => {
  const service = diagramCreationService(config, db, principal),
    request = input();
  writeFileSync(join(config.knowledgeRoot, request.path), '# 用户原文');
  expect(() => service.reserve(request)).toThrowError(
    expect.objectContaining({ code: 'NAME_CONFLICT' }),
  );
  for (const path of [
    '../outside.md',
    '/tmp/outside.md',
    '00-Inbox/a.excalidraw',
    '00-Inbox/assets/a.md',
  ])
    expect(() => service.reserve(input(path))).toThrow();
  expect(() =>
    service.reserve({ ...input('00-Inbox/future.md'), type: 'unknown' as 'whiteboard' }),
  ).toThrow();
});

it('allows the owning read-only actor to inspect an intent without acquiring mutation rights',()=>{
 const intent=diagramCreationService(config,db,principal).reserve(input()),reader=diagramCreationService(config,db,{...principal,scopes:['knowledge:read']});
 expect(reader.get(intent.id,{scope:'knowledge:read'})).toEqual(intent);
 expect(()=>reader.get(intent.id)).toThrowError(expect.objectContaining({statusCode:403}));
 expect(()=>reader.cancel(intent.id)).toThrowError(expect.objectContaining({statusCode:403}));
 const narrowed=diagramCreationService(config,db,{...principal,scopes:['knowledge:read'],allowedPrefixes:['private']});
 expect(()=>narrowed.get(intent.id,{scope:'knowledge:read'})).toThrowError(expect.objectContaining({statusCode:403}));
});
