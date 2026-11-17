import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { verifyMcpToDooWorkflow } from './support/verify-mcp-to-doo-workflow.js';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyHTTP } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  Client as CurrentClient,
  StreamableHTTPClientTransport as CurrentHTTP,
} from '@modelcontextprotocol/client';

// Run against an installed server. Secrets are read from a private file, never argv or reports.
// Read-only by default. Explicit --exercise-to-doo creates and soft-deletes isolated fixture entities.
const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    'token-file': { type: 'string' },
    report: { type: 'string' },
    'expect-server-version': { type: 'string' },
    knowledge: { type: 'boolean' },
    'to-doo': { type: 'boolean' },
    'exercise-to-doo': { type: 'boolean' },
  },
});
let phase = 'configuration';
try {
  if (!values.url || !values['token-file']) throw Error('MCP_VERIFIER_ARGUMENTS_REQUIRED');
  if (values['exercise-to-doo'] && !values['to-doo']) throw Error('MCP_VERIFIER_TODO_REQUIRED');
  const endpoint = new URL(values.url);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== 'https:' &&
      !(
        endpoint.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      ))
  )
    throw Error('MCP_VERIFIER_ENDPOINT_REQUIRED');
  const secretStat = await stat(values['token-file']);
  if (!secretStat.isFile() || secretStat.mode & 0o077)
    throw Error('MCP_VERIFIER_PRIVATE_TOKEN_FILE_REQUIRED');
  const token = (await readFile(values['token-file'], 'utf8')).trim();
  if (!token || /[\r\n]/.test(token)) throw Error('MCP_VERIFIER_TOKEN_REQUIRED');
  const records: {
    client: string;
    protocol: string | undefined;
    era: string;
    server: unknown;
    tools: number;
    checks: string[];
    workflow?: Awaited<ReturnType<typeof verifyMcpToDooWorkflow>>;
  }[] = [];
  for (const mode of ['v1', 'v2-legacy', 'v2-auto'] as const) {
    phase = mode + ':connect';
    const options = { requestInit: { headers: { authorization: 'Bearer ' + token } } };
    const client =
      mode === 'v1'
        ? new LegacyClient({ name: 'dooknow-installed-verification', version: '1' })
        : new CurrentClient(
            { name: 'dooknow-installed-verification', version: '2' },
            { versionNegotiation: { mode: mode === 'v2-auto' ? 'auto' : 'legacy' } },
          );
    try {
      if (client instanceof LegacyClient) await client.connect(new LegacyHTTP(endpoint, options));
      else await client.connect(new CurrentHTTP(endpoint, options));
      const server = client.getServerVersion();
      if (
        !server ||
        server.name !== 'doo-know' ||
        (values['expect-server-version'] && server.version !== values['expect-server-version'])
      )
        throw Error('MCP_VERIFIER_SERVER_MISMATCH');
      let cursor: string | undefined;
      const names = new Set<string>();
      do {
        phase = mode + ':tools/list';
        const page = await client.listTools(cursor ? { cursor } : {});
        if (Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: page })) > 65536)
          throw Error('MCP_VERIFIER_FRAME_TOO_LARGE');
        for (const tool of page.tools) {
          if (names.has(tool.name) || tool.inputSchema.type !== 'object')
            throw Error('MCP_VERIFIER_TOOL_SCHEMA');
          names.add(tool.name);
        }
        if (cursor && cursor === page.nextCursor) throw Error('MCP_VERIFIER_CURSOR_STALLED');
        cursor = page.nextCursor;
      } while (cursor);
      if (!names.size) throw Error('MCP_VERIFIER_NO_TOOLS');
      const checks = ['initialize', 'tools/list pagination', 'bounded frames'];
      const call = async (name: string, args: Record<string, unknown>) => {
        phase = mode + ':' + name;
        const result = await client.callTool({ name, arguments: args });
        if (
          result.isError ||
          !result.structuredContent ||
          typeof result.structuredContent !== 'object' ||
          !('data' in result.structuredContent)
        )
          throw Error('MCP_VERIFIER_TOOL_FAILED');
        return result.structuredContent.data as Record<string, any>;
      };
      if (values.knowledge) {
        await call('list_notes', { limit: 1 });
        checks.push('knowledge read');
      }
      if (values['to-doo']) {
        for (const name of [
          'begin_to_doo_anniversary_image',
          'finish_to_doo_anniversary_image',
          'read_to_doo_anniversary_image',
        ])
          if (!names.has(name)) throw Error('MCP_VERIFIER_IMAGE_TOOL_MISSING');
        const list = await call('describe_to_doo_schema', { category: 'entity', name: 'list' });
        if (!list.schema?.properties?.parentId || !list.schema?.properties?.icon)
          throw Error('MCP_VERIFIER_LIST_SCHEMA');
        const anniversary = await call('describe_to_doo_schema', {
          category: 'entity',
          name: 'anniversary',
        });
        if (!JSON.stringify(anniversary.schema).includes('zoom'))
          throw Error('MCP_VERIFIER_IMAGE_SCHEMA');
        const habit = await call('describe_to_doo_schema', {
          category: 'command',
          name: 'checkin_habit',
        });
        if (!JSON.stringify(habit.schema).includes('expectedHabitRevision'))
          throw Error('MCP_VERIFIER_HABIT_CAS');
        await call('query_to_doos', { kind: 'habit', limit: 1 });
        checks.push(
          'hierarchical lists',
          'anniversary image contract',
          'habit revision guard',
          'To Doo read',
        );
      }
      const workflow =
        values['exercise-to-doo'] && mode === 'v2-auto'
          ? await verifyMcpToDooWorkflow(call, 'mcp-verify-' + randomUUID(), { cleanup: true })
          : undefined;
      if (workflow) checks.push(...workflow.checks);
      records.push({
        client: mode,
        protocol:
          client instanceof LegacyClient ? undefined : client.getNegotiatedProtocolVersion(),
        era: client instanceof LegacyClient ? 'legacy' : client.getProtocolEra() || 'unknown',
        server,
        tools: names.size,
        checks,
        ...(workflow ? { workflow } : {}),
      });
    } finally {
      await client.close();
    }
  }
  const result = {
    verifiedAt: new Date().toISOString(),
    endpoint: endpoint.origin + endpoint.pathname,
    writes: records.reduce((sum, record) => sum + (record.workflow?.writes ?? 0), 0),
    records,
  };
  if (values.report)
    await writeFile(values.report, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
} catch (error) {
  // A remote error may include a credential or document text. Emit only the local phase/type.
  console.error(
    JSON.stringify({ ok: false, phase, errorType: error instanceof Error ? error.name : 'Error' }),
  );
  process.exitCode = 1;
}
