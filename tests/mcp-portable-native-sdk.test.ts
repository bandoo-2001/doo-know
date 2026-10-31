import { it, expect } from 'vitest';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { extract } from 'tar';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import { pluginServices } from '../apps/server/plugins/services';
import { pluginHost } from '../apps/server/plugins/host';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants';
import { policyScopes } from '../packages/core/auth/permissions';
import { createOperations, registerOperations } from '../plugins/mcp/server/operations';
import { hostClient } from '../plugins/mcp/server/service';
import { resultSize } from '../plugins/mcp/server/budgets';
import type { PermissionPolicy } from '../shared/permissions';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { parseDiagramDocument } from '../shared/diagram-document';
import { localReference } from '../packages/core/render';
import { sha256 } from '../packages/core/knowledge/operations';

// Tiny valid PNGs test byte bindings. Real render fidelity is covered by the offline browser spec.
function png(red: number) {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name),
      size = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
it('completes real read-only SDK export preview preparation, downloads the offline archive and reimports through a separate write grant', async () => {
  const f = await pluginRuntimeFixture(),
    close: Array<() => Promise<void>> = [];
  const directory = await mkdtemp(join(tmpdir(), 'native-sdk-offline-'));
  try {
    pluginHost(f.config, f.db);
    const runtime = f.platform.get(),
      principal = f.principal;
    const target = runtime.knowledge.core.create(
      principal,
      '00-Inbox',
      'sdk-native-target.md',
      '# SDK target\n',
      randomUUID(),
    );
    const source = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      elements: [
        {
          id: 'label',
          type: 'text',
          text: 'SDK label ' + 'x'.repeat(40000),
          link: f.config.origin + '/?note=' + target.id + '#part',
        },
      ],
      appState: {},
      files: {},
    });
    const intent = diagramCreationService(f.config, f.db, principal).reserve({
      path: '00-Inbox/sdk-native.md',
      type: 'whiteboard',
      requestId: randomUUID(),
    });
    const primary = primaryDiagramService(f.config, f.db, runtime.notes, runtime.assets, principal);
    const initialPng = png(20),
      prepared = primary.prepare({
        target: { kind: 'creation', intentId: intent.id },
        type: 'whiteboard',
        source,
        sourceHash: sha256(source),
        title: 'SDK Native',
        renderer: diagramRendererVersions.whiteboard,
        config: {},
        pngBase64: initialPng.toString('base64'),
        requestId: randomUUID(),
      });
    const original = primary.commit({
      preparedId: prepared.id,
      markdown: renderPreparedDiagramDocument({
        prepared,
        title: prepared.title,
        source,
        description: 'SDK original prose\n',
      }),
      requestId: randomUUID(),
    });
    const originalAssetCount = (
      f.db.prepare('SELECT count(*) n FROM assets').get() as { n: number }
    ).n;
    const manifest = JSON.parse(
      await readFile(new URL('../plugins/mcp/manifest.json', import.meta.url), 'utf8'),
    );
    const policy = (actions: ('read' | 'write')[]): PermissionPolicy => ({
      version: 2,
      domains: {
        knowledge: {
          enabled: true,
          ownerId: principal.id,
          instanceId: runtime.knowledge.organization.context(principal).libraryId,
          actions,
          resources: { mode: 'all' },
        },
      },
    });
    f.db
      .prepare(
        "INSERT INTO platform_plugins(id,installed_version,manifest_json,files_json,config_json,state) VALUES('mcp',?,?,'[]',?,'enabled')",
      )
      .run(
        manifest.version,
        JSON.stringify(manifest),
        JSON.stringify({ mode: 'oauth', permissionPolicy: policy(['read', 'write']) }),
      );
    async function sdk(actions: ('read' | 'write')[], name: string) {
      const permissionPolicy = policy(actions),
        grant = oauthGrantStore(f.db).approveV2(principal.id, name, permissionPolicy);
      const p = {
        id: principal.id,
        ownerId: principal.id,
        clientId: grant.clientId,
        grantId: grant.id,
        grantVersion: grant.version,
        tokenIssuedAt: Math.floor(Date.now() / 1000),
        pluginId: 'mcp',
        scopes: policyScopes(permissionPolicy),
        allowedPrefixes: [],
        permissionPolicy,
        policyVersion: 2 as const,
      };
      const operations = createOperations(
        { objectIdSecret: 'native-sdk-object-secret-at-least-thirty-two-characters' },
        hostClient(
          () =>
            pluginServices(f.platform, f.db, 'mcp', manifest.capabilities, {
              ownerId: p.id,
              principal: p,
              channel: 'mcp',
            }),
          () => ({}),
        ),
      );
      const server = new McpServer({ name, version: '1.0.0' });
      registerOperations(server, operations, p, {});
      const client = new Client({ name, version: '1.0.0' }),
        [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      close.push(async () => {
        await client.close();
        await server.close();
      });
      const raw = async (tool: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name: tool, arguments: args });
        expect(
          resultSize(result.structuredContent as Record<string, unknown>, '\\'.repeat(128)),
        ).toBeLessThanOrEqual(65536);
        return result;
      };
      return {
        raw,
        call: async (tool: string, args: Record<string, unknown>) => {
          const result = await raw(tool, args);
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          return (result.structuredContent as any).data;
        },
      };
    }
    const reader = await sdk(['read'], 'native-read-only');
    const args = {
      selection: { kind: 'single', noteId: original.id },
      requestId: 'sdk-native-export',
    };
    const pending = await reader.raw('export_portable_documents', args);
    expect(pending.isError).toBe(true);
    expect((pending.structuredContent as any).error).toMatchObject({
      code: 'DIAGRAM_PREVIEW_REQUIRED',
    });
    const needs = await reader.call('list_portable_previews', {
      requestId: args.requestId,
      direction: 'export',
    });
    expect(needs.items).toHaveLength(1);
    const need = needs.items[0];
    const pieces: Buffer[] = [];
    let offset = 0,
      done = false;
    while (!done) {
      const next = await reader.call('get_portable_preview', {
        previewId: need.previewId,
        offset,
        maxBytes: 16384,
      });
      expect(next.source.offset).toBe(offset);
      pieces.push(Buffer.from(next.source.content, 'base64'));
      offset = next.source.nextOffset;
      done = next.source.eof;
    }
    const finalSource = Buffer.concat(pieces).toString('utf8');
    expect(offset).toBeGreaterThan(16384);
    expect(sha256(finalSource)).toBe(need.sourceHash);
    expect(finalSource).not.toContain('?note=');
    const freshPng = png(200),
      upload = await reader.call('begin_portable_preview_upload', {
        previewId: need.previewId,
        sourceHash: need.sourceHash,
        totalBytes: freshPng.length,
        sha256: sha256(freshPng),
        requestId: 'sdk-native-png-upload',
      });
    await reader.call('append_mcp_upload', {
      transferId: upload.transferId,
      offset: 0,
      base64: freshPng.toString('base64'),
    });
    await reader.call('prepare_portable_preview', {
      previewId: need.previewId,
      sourceHash: need.sourceHash,
      transferId: upload.transferId,
      requestId: 'sdk-native-prepare',
    });
    const exported = await reader.call('export_portable_documents', args);
    expect(exported.kind).toBe('archive');
    expect(runtime.notes.getNote(original.id).content).toBe(original.content);
    expect(runtime.assets.file(prepared.source!.relativePath).bytes.toString('utf8')).toBe(source);
    expect((f.db.prepare('SELECT count(*) n FROM assets').get() as { n: number }).n).toBe(
      originalAssetCount,
    );
    const chunks: Buffer[] = [];
    offset = 0;
    done = false;
    while (!done) {
      const next = await reader.call('read_mcp_transfer', {
        transferId: exported.download.transferId,
        offset,
      });
      chunks.push(Buffer.from(next.base64, 'base64'));
      offset = next.nextOffset;
      done = next.done;
    }
    const bytes = Buffer.concat(chunks);
    expect(sha256(bytes)).toBe(exported.sha256);
    const archive = join(directory, 'documents.tar.gz'),
      unpacked = join(directory, 'relocated');
    await writeFile(archive, bytes);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(unpacked);
    await extract({ file: archive, cwd: unpacked });
    const markdown = await readFile(join(unpacked, original.relativePath), 'utf8'),
      parsed = parseDiagramDocument(markdown);
    expect(parsed.status).toBe('diagram');
    if (parsed.status !== 'diagram' || parsed.primary.source.format !== 'excalidraw')
      throw Error('missing fixed main');
    const sourcePath = localReference(original.relativePath, parsed.primary.source.path)!;
    expect(await readFile(join(unpacked, sourcePath), 'utf8')).toBe(finalSource);
    expect(localReference(sourcePath, JSON.parse(finalSource).elements[0].link)).toBe(
      target.relativePath,
    );
    expect(
      sha256(
        await readFile(
          join(unpacked, localReference(original.relativePath, parsed.primary.previewPath)!),
        ),
      ),
    ).toBe(sha256(freshPng));
    expect(parsed.primary.binding.previewHash).not.toBe(prepared.previewHash);
    const writer = await sdk(['read', 'write'], 'native-import-writer'),
      folderPath = '00-Inbox/sdk-native-import';
    const input = await writer.call('begin_portable_import_upload', {
      folderPath,
      name: exported.fileName,
      mime: exported.mime,
      totalBytes: bytes.length,
      sha256: sha256(bytes),
      requestId: 'sdk-native-package-upload',
    });
    for (let at = 0; at < bytes.length; at += 16384)
      await writer.call('append_mcp_upload', {
        transferId: input.transferId,
        offset: at,
        base64: bytes.subarray(at, at + 16384).toString('base64'),
      });
    expect(
      await writer.call('import_portable_archive', {
        transferId: input.transferId,
        folderPath,
        requestId: 'sdk-native-import',
      }),
    ).toMatchObject({ state: 'succeeded', notesImported: 2 });
    const mapping = await writer.call('get_portable_import_result', {
      requestId: 'sdk-native-import',
    });
    const copy = mapping.items.find((item: any) => item.sourcePath === original.relativePath);
    expect(copy.noteId).not.toBe(original.id);
    const result = primaryDiagramService(
      f.config,
      f.db,
      runtime.notes,
      runtime.assets,
      principal,
    ).resolve(copy.noteId);
    expect(result.preview?.state).toBe('ready');
    expect(result.source.content).toBe(finalSource);
  } finally {
    for (const cleanup of close.reverse()) await cleanup();
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
