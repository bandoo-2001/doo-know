import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import { createKnowledgeToolPort } from '../apps/server/plugins/knowledge-tools';
import { createMcpTransferStore } from '../apps/server/plugins/mcp-transfers';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { emptyWhiteboard } from '../shared/whiteboard';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { requireScope } from '../packages/core/agent/auth';
import { mcpResultFrameSize, mcpMaximumFrameBytes } from '../shared/mcp-frame';
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const end of close.splice(0).reverse()) await end();
});
const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture() {
  const f = await pluginRuntimeFixture();
  close.push(f.close);
  const runtime = f.platform.get(),
    primary = primaryDiagramService(f.config, f.db, runtime.notes, runtime.assets, f.principal),
    intent = diagramCreationService(f.config, f.db, f.principal).reserve({
      path: '00-Inbox/source.md',
      type: 'whiteboard',
      requestId: randomUUID(),
    }),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'label', type: 'text', text: '大原件'.repeat(4000) }],
    });
  const prepared = primary.prepare({
      target: { kind: 'creation', intentId: intent.id },
      type: 'whiteboard',
      source,
      sourceHash: sha(source),
      title: 'MCP原件',
      renderer: diagramRendererVersions.whiteboard,
      config: {},
      pngBase64: png,
      requestId: randomUUID(),
    }),
    markdown = renderPreparedDiagramDocument({ prepared, title: prepared.title, source });
  primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
  const transfers = createMcpTransferStore(f.config, f.db),
    port = createKnowledgeToolPort({
      config: f.config,
      db: f.db,
      runtime,
      transfers,
      authorize(scopes) {
        for (const scope of scopes) requireScope(f.principal, scope);
        return f.principal;
      },
      toDooAccess: () => ({ listIds: [], domains: [] }),
    });
  return { ...f, runtime, primary, prepared, intent, source, markdown, transfers, port };
}
it('returns bounded semantic metadata and an actor-owned opaque source snapshot', async () => {
  const f = await fixture(),
    resource: any = await f.port.call('get_note_diagram', { noteId: f.intent.noteId });
  expect(resource).toMatchObject({
    documentType: 'whiteboard',
    role: 'primary',
    source: { hash: sha(f.source), readHandle: expect.any(String) },
  });
  expect(resource.source).not.toHaveProperty('content');
  expect(mcpResultFrameSize({ data: resource })).toBeLessThanOrEqual(mcpMaximumFrameBytes);
  const info = f.transfers.info(f.principal, resource.source.readHandle);
  f.port.authorizeTransfer(info.binding, false);
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < info.totalBytes) {
    f.port.authorizeTransfer(info.binding, false);
    const page = f.transfers.read(f.principal, { transferId: info.transferId, offset });
    chunks.push(Buffer.from(page.base64, 'base64'));
    offset = page.nextOffset;
  }
  expect(Buffer.concat(chunks).toString('utf8')).toBe(f.source);
  expect(() =>
    f.transfers.info({ ...f.principal, clientId: 'another-client' }, info.transferId),
  ).toThrowError(expect.objectContaining({ statusCode: 404 }));
});
it('rechecks the current note version before later source chunks are authorized', async () => {
  const f = await fixture(),
    resource: any = await f.port.call('get_note_diagram', { noteId: f.intent.noteId }),
    info = f.transfers.info(f.principal, resource.source.readHandle);
  const note = f.runtime.notes.getNote(f.intent.noteId);
  f.runtime.knowledge.core.update(
    f.principal,
    note.id,
    f.markdown + '新说明\n',
    note.modifiedAt,
    randomUUID(),
  );
  expect(() => f.port.authorizeTransfer(info.binding, false)).toThrowError(
    expect.objectContaining({ code: 'STALE_CURSOR' }),
  );
});

it('keeps semantic Markdown graph types and pending publication status in the SDK metadata contract',async()=>{
 const f=await fixture(),info=await f.runtime.knowledge.info(f.principal,f.intent.noteId),{noteInfo}=await import('../plugins/mcp/server/contracts');
 expect(info.documentType).toBe('whiteboard');expect(noteInfo.parse(info).documentType).toBe('whiteboard');
});
