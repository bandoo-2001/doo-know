import { ref } from 'vue';
import type { FeatureView } from '../../../shared/feature-contracts';

export const gitAuthorDraft = ref<{
  authorName: string;
  authorEmail: string;
  baseline: string;
  version: number;
}>();

export function hasUnsavedGitSettings() {
  const draft = gitAuthorDraft.value;
  return !!draft && JSON.stringify([draft.authorName, draft.authorEmail]) !== draft.baseline;
}

export function loadGitAuthorDraft(feature: FeatureView, discard = false) {
  const current = gitAuthorDraft.value;
  if (!discard && current && (current.version === feature.configVersion || hasUnsavedGitSettings()))
    return;
  const authorName = String(feature.config.authorName || '');
  const authorEmail = String(feature.config.authorEmail || '');
  gitAuthorDraft.value = {
    authorName,
    authorEmail,
    baseline: JSON.stringify([authorName, authorEmail]),
    version: feature.configVersion,
  };
}
