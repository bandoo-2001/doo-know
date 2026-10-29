import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AppConfig } from '../shared/contracts.js';
import { createGraphModel } from '../packages/core/graph/model.js';
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'graph-model-'));
  roots.push(dataRoot);
  const db = new Database(':memory:');
  return {
    db,
    model: createGraphModel(
      { dataRoot, secret: 'synthetic-host-secret-for-fixtures' } as AppConfig,
      db,
    ),
  };
}
async function fixture(output: unknown, inspect: (body: any, headers: any) => void) {
  const s = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    inspect(JSON.parse(body), req.headers);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(output));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as any).port}`;
}
const extraction = {
  entities: [{ name: 'Alpha', kind: 'concept', description: '', aliases: [], quote: 'Alpha' }],
  relations: [],
};
it('defaults, CAS, private secrets and endpoint rotation', () => {
  const { model, db } = setup();
  expect(model.settings().provider).toBe('none');
  const initial = model.settings();
  const next = {
    ...initial,
    expectedVersion: 0,
    provider: 'ollama' as const,
    baseUrl: 'http://127.0.0.1:1234',
    model: 'small',
    apiKey: 'secret-fixture',
  };
  model.update(next);
  expect(JSON.stringify(model.settings())).not.toContain('secret-fixture');
  expect(() => model.update(next)).toThrow('graph_model_conflict');
  const before = model.fingerprint();
  model.update({
    ...next,
    expectedVersion: 1,
    baseUrl: 'http://localhost:1234',
    apiKey: undefined,
  });
  expect(model.settings().apiKeyConfigured).toBe(false);
  expect(model.fingerprint()).not.toBe(before);
  expect(JSON.stringify(db.prepare('SELECT * FROM graph_model_config').all())).not.toContain(
    'secret-fixture',
  );
});
for (const provider of ['ollama', 'openai-compatible'] as const)
  it(`real fetch structured ${provider}`, async () => {
    const url = await fixture(
      provider === 'ollama'
        ? { message: { content: JSON.stringify(extraction) } }
        : { choices: [{ message: { content: JSON.stringify(extraction) } }] },
      (body) => {
        expect(body.stream).toBe(false);
        expect(
          provider === 'ollama'
            ? body.format.additionalProperties
            : body.response_format.json_schema.strict,
        ).toBe(provider === 'ollama' ? false : true);
      },
    );
    const { model } = setup();
    model.update({
      ...model.settings(),
      expectedVersion: 0,
      provider,
      baseUrl: url,
      model: 'synthetic',
    });
    expect(await model.extract('Alpha is a concept')).toEqual(extraction);
  });
it('rejects fabricated evidence and unknown citations', async () => {
  const url = await fixture(
    {
      message: {
        content: JSON.stringify({
          ...extraction,
          entities: [{ ...extraction.entities[0], quote: 'invented' }],
        }),
      },
    },
    () => {},
  );
  const { model } = setup();
  model.update({
    ...model.settings(),
    expectedVersion: 0,
    provider: 'ollama',
    baseUrl: url,
    model: 'x',
  });
  await expect(model.extract('Alpha')).rejects.toThrow('graph_model_invalid_response');
});
it('blocks remote content and unsafe endpoints', async () => {
  const { model } = setup();
  expect(() =>
    model.update({
      ...model.settings(),
      expectedVersion: 0,
      provider: 'ollama',
      baseUrl: 'https://user:secret@example.com?q=x',
      model: 'x',
    }),
  ).toThrow('graph_model_invalid_settings');
  model.update({
    ...model.settings(),
    expectedVersion: 0,
    provider: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    model: 'x',
  });
  await expect(model.extract('private')).rejects.toThrow('graph_model_remote_content_disabled');
});
it('answers only with supplied context citations', async () => {
  const url = await fixture(
    {
      choices: [
        { message: { content: JSON.stringify({ answer: 'Alpha', citations: ['unknown'] }) } },
      ],
    },
    () => {},
  );
  const { model } = setup();
  model.update({
    ...model.settings(),
    expectedVersion: 0,
    provider: 'openai-compatible',
    baseUrl: url,
    model: 'x',
  });
  await expect(
    model.answer('What?', [{ id: 'known', text: 'Alpha', title: 'Fixture' }]),
  ).rejects.toThrow('graph_model_invalid_response');
});
it('cancellation terminates fetch and permits a subsequent call', async () => {
  let calls = 0;
  const s = createServer(async (req, res) => {
    for await (const c of req) {
    }
    calls++;
    if (calls > 1) res.end(JSON.stringify({ message: { content: JSON.stringify(extraction) } }));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { model } = setup();
  model.update({
    ...model.settings(),
    expectedVersion: 0,
    provider: 'ollama',
    baseUrl: `http://127.0.0.1:${(s.address() as any).port}`,
    model: 'x',
  });
  const controller = new AbortController();
  const pending = model.extract('Alpha', controller.signal);
  setTimeout(() => controller.abort(), 40);
  await expect(pending).rejects.toThrow('graph_model_aborted');
  expect(await model.extract('Alpha')).toEqual(extraction);
  s.closeAllConnections();
});
it('does not follow redirects or disclose credentials through errors', async () => {
  const s = createServer((req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:1/secret-fixture' });
    res.end();
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { model } = setup();
  model.update({
    ...model.settings(),
    expectedVersion: 0,
    provider: 'ollama',
    baseUrl: `http://127.0.0.1:${(s.address() as any).port}`,
    model: 'x',
    apiKey: 'secret-fixture',
  });
  expect(await model.test()).toEqual({ ok: false, message: 'graph_model_network_error' });
});
it('honors explicit JSON mode with the same strict validation', async () => {
  let received: any;
  const url = await fixture(
    { choices: [{ message: { content: JSON.stringify(extraction) } }] },
    (body) => {
      received = body;
    },
  );
  const { model } = setup();
  model.update({
    ...model.settings(),
    expectedVersion: 0,
    provider: 'openai-compatible',
    baseUrl: url,
    model: 'x',
    timeoutMs: 200,
    outputFormat: 'json',
  } as any);
  expect(await model.extract('Alpha')).toEqual(extraction);
  expect(received.response_format).toEqual({ type: 'json_object' });
});
it('reports an unconfigured model explicitly without network', async () => {
  const { model } = setup();
  expect(await model.test()).toEqual({ ok: false, message: 'graph_model_not_configured' });
  await expect(model.extract('Alpha')).rejects.toThrow('graph_model_not_configured');
  await expect(model.answer('Why?', [])).rejects.toThrow('graph_model_not_configured');
});
it('restores encrypted credentials using the backed-up host secret', async () => {
  let authorization: string | undefined;
  const url = await fixture(
    { message: { content: JSON.stringify(extraction) } },
    (_body, headers) => {
      authorization = headers.authorization;
    },
  );
  const { model, db } = setup();
  model.update({
    ...model.settings(),
    expectedVersion: 0,
    provider: 'ollama',
    baseUrl: url,
    model: 'x',
    apiKey: 'synthetic-api-token',
  });
  const restored = createGraphModel(
    { secret: 'synthetic-host-secret-for-fixtures' } as AppConfig,
    db,
  );
  expect(await restored.extract('Alpha')).toEqual(extraction);
  expect(authorization).toBe('Bearer synthetic-api-token');
  const wrong = createGraphModel({ secret: 'different-synthetic-host-secret' } as AppConfig, db);
  expect(await wrong.test()).toEqual({ ok: false, message: 'graph_model_secret_unavailable' });
});
for (const mode of ['length', 'status', 'stream'] as const)
  it(`closes unfinished ${mode} responses before releasing model slots`, async () => {
    let open = 0;
    const server = createServer(async (req, res) => {
      for await (const chunk of req) {
        void chunk;
      }
      open++;
      res.on('close', () => {
        open--;
      });
      res.writeHead(
        mode === 'status' ? 503 : 200,
        mode === 'length' ? { 'content-length': '300000' } : {},
      );
      res.flushHeaders();
      if (mode === 'stream') res.write('x'.repeat(262145));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { model } = setup();
    model.update({
      ...model.settings(),
      expectedVersion: 0,
      provider: 'ollama',
      model: 'synthetic',
      timeoutMs: 100,
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    });
    try {
      for (let i = 0; i < 5; i++)
        expect(await model.test()).toEqual({
          ok: false,
          message: mode === 'status' ? 'graph_model_http_error' : 'graph_model_response_too_large',
        });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(open).toBe(0);
    } finally {
      server.closeAllConnections();
    }
  });
it('allows literal RFC1918 IPs and rejects hostname prefixes masquerading as private IPs', () => {
  for (const host of [
    '10.public-example.test',
    '192.168.public-example.test',
    '172.16.public-example.test',
  ]) {
    const { model } = setup();
    expect(() =>
      model.update({
        ...model.settings(),
        expectedVersion: 0,
        provider: 'ollama',
        model: 'x',
        baseUrl: `http://${host}`,
        remoteContentAllowed: true,
      }),
    ).toThrow('graph_model_invalid_settings');
  }
  for (const host of ['10.1.2.3', '192.168.1.2', '172.16.1.2', '172.31.255.254']) {
    const { model } = setup();
    expect(
      model.update({
        ...model.settings(),
        expectedVersion: 0,
        provider: 'ollama',
        model: 'x',
        baseUrl: `http://${host}`,
      }).baseUrl,
    ).toBe(`http://${host}`);
  }
});
it('fingerprint tracks extraction inputs rather than scheduler state or CAS version', () => {
  const { model } = setup();
  model.update({
    ...model.settings(),
    expectedVersion: 0,
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'synthetic',
  });
  const original = model.fingerprint();
  model.update({
    ...model.settings(),
    expectedVersion: model.settings().version,
    automatic: false,
  });
  expect(model.fingerprint()).toBe(original);
  model.update({ ...model.settings(), expectedVersion: model.settings().version });
  expect(model.fingerprint()).toBe(original);
  for (const change of [
    { model: 'different' },
    { maxInputCharacters: 13000 },
    { remoteContentAllowed: true },
    { apiKey: 'synthetic-token' },
    { timeoutMs: 10000 },
    { outputFormat: 'json' as const },
  ]) {
    const before = model.fingerprint();
    model.update({ ...model.settings(), expectedVersion: model.settings().version, ...change });
    expect(model.fingerprint()).not.toBe(before);
  }
});
