import { shallowRef } from 'vue';
import type { FeatureId } from '../../shared/feature-config';
import type { FeatureView } from '../../shared/feature-contracts';
import { api } from './api';
import { gitAuthorDraft } from './git/settings-draft';

export const features = shallowRef<Partial<Record<FeatureId, FeatureView>>>({});
let session = 0;
let sequence = 0;

export async function refreshFeatures() {
  const request = ++sequence;
  const state = await api<Record<FeatureId, FeatureView>>('/api/platform/features');
  if (request === sequence) features.value = state;
}

async function updateFeature(id: FeatureId, route: string, body: unknown) {
  const currentSession = session;
  const result = await api<FeatureView>(`/api/platform/${id}/${route}`, 'PUT', body);
  if (currentSession === session) {
    sequence++;
    features.value = { ...features.value, [id]: result };
  }
  return result;
}

export function setFeatureEnabled(id: FeatureId, enabled: boolean) {
  return updateFeature(id, 'enabled', { enabled });
}

export function saveFeatureConfig(
  id: FeatureId,
  values: Record<string, unknown>,
  configVersion: number,
) {
  return updateFeature(id, 'config', { values, configVersion });
}

export function featureAction<T = any>(
  feature: FeatureId,
  kind: 'command' | 'provider',
  id: string,
  input: unknown,
) {
  return api<T>(`/api/platform/${feature}/actions`, 'POST', { kind, id, input });
}

export function clearFeatures() {
  session++;
  sequence++;
  features.value = {};
  gitAuthorDraft.value = undefined;
}
