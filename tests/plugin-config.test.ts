import { expect, it } from 'vitest';
import type { PluginManifest, PluginView } from '../packages/plugin-contracts';
import mcpManifest from '../plugins/mcp/manifest.json';
const manifest = mcpManifest as PluginManifest;
import {
  createPluginDraft,
  refreshPluginDraft,
  pluginDraftDirty,
  pluginFieldVisible,
  serializePluginDraft,
} from '../apps/web/plugin-config';

function plugin(overrides: Partial<PluginView> = {}): PluginView {
  return {
    id: 'mcp',
    installedVersion: '1.0.1',
    desiredEnabled: false,
    state: 'disabled',
    configVersion: 7,
    restartRequired: false,
    manifest,
    config: { mode: 'both', allowedPrefixes: ['资料/项目', 'README.md'], compatPort: 3071 },
    configuredSecrets: ['tunnelToken'],
    ...overrides,
  };
}

it('edits directory prefixes as separate lines and retains hidden Tunnel settings in the save payload', () => {
  const source = plugin(),
    draft = createPluginDraft(source);
  expect(draft.values.allowedPrefixes).toBe('资料/项目\nREADME.md');
  expect(draft.values.tunnelToken).toBe('');
  expect(pluginDraftDirty(draft)).toBe(false);
  draft.values.mode = 'oauth';
  draft.values.allowedPrefixes = '文档/测试\r\n 空格目录 \r\n';
  draft.values.tunnelToken = 'new-connection-key'.repeat(3);
  expect(pluginDraftDirty(draft)).toBe(true);
  for (const key of ['compatPort', 'tunnelToken', 'tunnelOrigin']) {
    expect(pluginFieldVisible('mcp', key, 'oauth')).toBe(false);
    expect(pluginFieldVisible('mcp', key, 'tunnel')).toBe(true);
    expect(pluginFieldVisible('mcp', key, 'both')).toBe(true);
  }
  expect(serializePluginDraft(draft, source)).toMatchObject({
    configVersion: 7,
    values: {
      mode: 'oauth',
      allowedPrefixes: ['文档/测试', ' 空格目录 '],
      compatPort: 3071,
      tunnelToken: 'new-connection-key'.repeat(3),
    },
  });
});

it.each([
  '',
  '../private',
  '/absolute',
  '资料//项目',
  '.private',
  '资料/.private',
  'bad\\path',
  'a\n\nb',
  'bad\u0000path',
])('refuses invalid directory entries without silently normalizing them: %j', (prefixes) => {
  const source = plugin(),
    draft = createPluginDraft(source);
  draft.values.allowedPrefixes = prefixes;
  expect(() => serializePluginDraft(draft, source)).toThrow(/允许访问的目录/);
  expect(draft.values.allowedPrefixes).toBe(prefixes);
});

it('enforces the existing 64-directory limit', () => {
  const source = plugin(),
    draft = createPluginDraft(source);
  draft.values.allowedPrefixes = Array.from({ length: 65 }, (_, i) => '目录' + i).join('\n');
  expect(() => serializePluginDraft(draft, source)).toThrow(/允许访问的目录/);
});

it('retains unsaved inputs on status refresh and blocks stale saves until an explicit reload', () => {
  const source = plugin(),
    draft = createPluginDraft(source);
  draft.values.allowedPrefixes = '我的未保存目录';
  draft.values.tunnelToken = 'unsaved-secret'.repeat(4);
  const unchanged = refreshPluginDraft(draft, { ...source, state: 'enabled' });
  expect(unchanged).toBe(draft);
  const remote = plugin({ configVersion: 8, config: { ...source.config, readOnly: false } }),
    conflicted = refreshPluginDraft(unchanged, remote);
  expect(conflicted.values.allowedPrefixes).toBe('我的未保存目录');
  expect(conflicted.values.tunnelToken).toBe('unsaved-secret'.repeat(4));
  expect(conflicted.configVersion).toBe(7);
  expect(conflicted.conflicted).toBe(true);
  expect(() => serializePluginDraft(conflicted, remote)).toThrow(/重新载入/);
  const reloaded = createPluginDraft(remote);
  expect(pluginDraftDirty(reloaded)).toBe(false);
  expect(reloaded.values.readOnly).toBe(false);
  expect(serializePluginDraft(reloaded, remote).configVersion).toBe(8);
});

it('rejects an unobserved remote version change using the original draft baseline', () => {
  const source = plugin(),
    draft = createPluginDraft(source);
  draft.values.readOnly = false;
  expect(serializePluginDraft(draft, source).configVersion).toBe(7);
  expect(() => serializePluginDraft(draft, plugin({ configVersion: 8 }))).toThrow(/重新载入/);
});

it('keeps advanced JSON parsing and explicit secret clearing while blank secrets retain the saved value', () => {
  const source = plugin({
    manifest: {
      ...manifest,
      configSchema: {
        ...manifest.configSchema,
        properties: { ...manifest.configSchema.properties, options: { type: 'object' } },
      },
    },
    config: { allowedPrefixes: ['README.md'], options: { nested: ['保留结构'] } },
  });
  const draft = createPluginDraft(source);
  expect(serializePluginDraft(draft, source).values).not.toHaveProperty('tunnelToken');
  expect(serializePluginDraft(draft, source).values.options).toEqual({ nested: ['保留结构'] });
  draft.values.options = '[]';
  expect(() => serializePluginDraft(draft, source)).toThrow(/JSON 对象/);
  draft.values.options = '{}';
  draft.values.tunnelToken = null;
  expect(serializePluginDraft(draft, source).values.tunnelToken).toBeNull();
});
