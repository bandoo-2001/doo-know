import { expect, it } from 'vitest';
import { clearMcpSettings, hasUnsavedMcpSettings, loadMcpDraft, mcpDraftSession, mcpSettingsDraft } from '../apps/web/mcp-settings-draft';
import type { FeatureView } from '../shared/feature-contracts';

const saved = (version: number): FeatureView => ({
  id: 'mcp', state: 'disabled', desiredEnabled: false, configVersion: version,
  config: { allowedPrefixes: ['00-Inbox'], oauthEnabled: true, apiKeyEnabled: true },
});

it('keeps edited settings while a newer configuration is observed and reloads explicitly', () => {
  clearMcpSettings();
  const session = mcpDraftSession();
  loadMcpDraft(saved(1), session);
  mcpSettingsDraft.value!.values.oauthEnabled = false;
  loadMcpDraft(saved(2), session);
  expect(hasUnsavedMcpSettings()).toBe(true);
  expect(mcpSettingsDraft.value).toMatchObject({ configVersion: 1, values: { oauthEnabled: false } });
  loadMcpDraft(saved(2), session, true);
  expect(mcpSettingsDraft.value).toMatchObject({ configVersion: 2, values: { oauthEnabled: true } });
  expect(hasUnsavedMcpSettings()).toBe(false);
  clearMcpSettings();
});

it('discards edits on sign-out and rejects stale results from the old session', () => {
  const session = mcpDraftSession();
  loadMcpDraft(saved(1), session);
  mcpSettingsDraft.value!.values.oauthEnabled = false;
  clearMcpSettings();
  loadMcpDraft(saved(2), session, true);
  expect(mcpSettingsDraft.value).toBeUndefined();
  expect(hasUnsavedMcpSettings()).toBe(false);
});
