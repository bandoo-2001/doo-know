import { readFile } from 'node:fs/promises';
import { satisfies } from 'semver';
import { expect, it } from 'vitest';
import { HOST_PLUGIN_API } from '../packages/plugin-contracts';

it('requires the extended To Doo host contract for the new MCP bundle while retaining older caret plugins', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../plugins/mcp/manifest.json', import.meta.url), 'utf8'),
  );
  const git = JSON.parse(
    await readFile(new URL('../plugins/git/manifest.json', import.meta.url), 'utf8'),
  );
  expect(manifest.version).toBe('2.0.5');
  expect(manifest.apiVersion).toBe('^1.5.0');
  // Existing 1.4 hosts lack anniversary image tools and reject taskScope.
  expect(satisfies('1.4.0', manifest.apiVersion)).toBe(false);
  expect(satisfies(HOST_PLUGIN_API, manifest.apiVersion)).toBe(true);
  expect(git.version).toBe('1.1.4');
  expect(git.apiVersion).toBe('^1.0.0');
  expect(satisfies(HOST_PLUGIN_API, git.apiVersion)).toBe(true);
  expect(satisfies(HOST_PLUGIN_API, '^1.4.0')).toBe(true);
});
