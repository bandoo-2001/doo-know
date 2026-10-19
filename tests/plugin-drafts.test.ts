import { afterEach, expect, it } from 'vitest';
import {
  clearPluginDrafts,
  hasUnsavedPluginDrafts,
  pluginDraftSession,
  pluginDrafts,
  storePluginDraft,
} from '../apps/web/plugin-drafts';
import type { PluginConfigDraft } from '../apps/web/plugin-config';

afterEach(clearPluginDrafts);

function sample(pluginId: string): PluginConfigDraft {
  const values = { name: 'saved' };
  return {
    pluginId,
    configVersion: 1,
    values,
    savedValues: JSON.stringify(values),
    conflicted: false,
  };
}

it('detects unsaved inputs across plugin views and clears all session drafts together', () => {
  const session = pluginDraftSession();
  storePluginDraft(sample('mcp'), session);
  storePluginDraft(sample('git'), session);
  expect(hasUnsavedPluginDrafts()).toBe(false);
  pluginDrafts.git.values.name = 'unsaved';
  expect(hasUnsavedPluginDrafts()).toBe(true);
  clearPluginDrafts();
  expect(hasUnsavedPluginDrafts()).toBe(false);
  expect(Object.keys(pluginDrafts)).toEqual([]);
});

it('rejects an older workspace asynchronous response after logout has cleared the draft session', () => {
  const oldSession = pluginDraftSession();
  const oldDraft = sample('mcp');
  oldDraft.values.name = 'old workspace input';
  storePluginDraft(oldDraft, oldSession);
  clearPluginDrafts();
  const next = sample('mcp');
  next.values.name = 'new workspace input';
  expect(storePluginDraft(next, pluginDraftSession())).toBe(true);
  expect(storePluginDraft(oldDraft, oldSession)).toBe(false);
  expect(pluginDrafts.mcp.values.name).toBe('new workspace input');
});
