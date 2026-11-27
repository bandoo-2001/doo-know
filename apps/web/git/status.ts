import { shallowRef } from 'vue';
import { featureAction, features } from '../features';

type GitStatus = {
  repository: 'ready' | 'missing' | 'unavailable';
  branch?: string;
  code?: string;
  changes?: { path: string; code: string }[];
  pending?: { operationId: string; commit?: string; requestId: string; phase: string }[];
};
export const gitStatus = shallowRef<GitStatus>();
let pending: Promise<void> | undefined;
let epoch = 0;

export function refreshGitStatus() {
  if (features.value.git?.state !== 'enabled') return Promise.resolve();
  if (pending) return pending;
  const generation = epoch;
  pending = featureAction<GitStatus>('git', 'provider', 'git.status', {})
    .then((result) => {
      if (generation === epoch && features.value.git?.state === 'enabled') gitStatus.value = result;
    })
    .finally(() => {
      if (generation === epoch) pending = undefined;
    });
  return pending;
}

export function clearGitStatus() {
  epoch++;
  pending = undefined;
  gitStatus.value = undefined;
}
