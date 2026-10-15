import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHostConfig } from '../apps/server/platform/config.js';
it('loads an explicit profile without a knowledge root and resolves command over environment over profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'dooknow-config-'));
  try {
    const secretFile = join(root, 'auth.key'), profileFile = join(root, 'profile.json');
    writeFileSync(secretFile, 'test-only-at-least-thirty-two-characters-secret', { mode: 0o600 });
    writeFileSync(profileFile, JSON.stringify({ dataRoot: join(root, 'data'), secretFile, port: 15170, origin: 'http://127.0.0.1:15173', allowedKnowledgeBases: [join(root, 'libraries')] }));
    const config = loadHostConfig({ profileFile, port: 15173 }, { PORT: '15172' });
    expect(config.knowledgeRoot).toBeUndefined();
    expect(config.port).toBe(15173);
    expect(config.dataRoot).toBe(join(root, 'data'));
    expect(config.allowedKnowledgeBases).toEqual([join(root, 'libraries')]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('refuses a missing authentication secret instead of replacing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dooknow-config-'));
  try { expect(() => loadHostConfig({ secretFile: join(root, 'missing.key'), dataRoot: join(root, 'data') }, {})).toThrow(); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
