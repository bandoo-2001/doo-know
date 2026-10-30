import { expect, it } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { openDatabase } from '../packages/core/db.js';
import { createMcpTransferStore } from '../apps/server/plugins/mcp-transfers.js';

it('serves complete downloads to the signed-in owner without bearer tokens or filesystem paths', async () => {
  const f = await createFixture(), db = openDatabase(f.dataRoot);
  try {
    const headers = await loginFixtureOwner(f);
    const owner = (db.prepare('SELECT id FROM user LIMIT 1').get() as { id: string }).id;
    const store = createMcpTransferStore(f.config, db);
    const meta = store.createDownload({ id: owner, clientId: 'mcp', scopes: ['knowledge:read'], allowedPrefixes: [] }, { requestId: 'export', binding: { domain: 'knowledge', kind: 'document-download', id: 'note' }, name: '资料.html', mime: 'text/html', bytes: Buffer.from('<script>untrusted()</script>') });
    const url = '/api/mcp/transfers/' + meta.transferId + '/download';
    expect((await f.app.inject({ url })).statusCode).toBe(401);
    const response = await f.app.inject({ url, headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toBe('<script>untrusted()</script>');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-security-policy']).toContain('sandbox');
    const other = store.createDownload({ id: 'another-owner', clientId: 'mcp', scopes: [], allowedPrefixes: [] }, { requestId: 'other', binding: { domain: 'knowledge', kind: 'document-download', id: 'note' }, name: 'private.txt', mime: 'text/plain', bytes: Buffer.from('private') });
    expect((await f.app.inject({ url: '/api/mcp/transfers/' + other.transferId + '/download', headers })).statusCode).toBe(404);
  } finally { db.close(); await f.close(); }
});
