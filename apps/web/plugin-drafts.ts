import { reactive } from 'vue';
import { pluginDraftDirty, type PluginConfigDraft } from './plugin-config';

// This cache lives only in the current JavaScript session. Never persist connection keys.
export const pluginDrafts = reactive<Record<string, PluginConfigDraft>>({});
let session = 0;

export function pluginDraftSession() {
  return session;
}

export function storePluginDraft(draft: PluginConfigDraft, expectedSession: number) {
  if (expectedSession !== session) return false;
  pluginDrafts[draft.pluginId] = draft;
  return true;
}

export function hasUnsavedPluginDrafts() {
  return Object.values(pluginDrafts).some(pluginDraftDirty);
}

export function clearPluginDrafts() {
  // Fence requests from an unmounted workspace before accepting the next owner's drafts.
  session++;
  for (const id of Object.keys(pluginDrafts)) delete pluginDrafts[id];
}
