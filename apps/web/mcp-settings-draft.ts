import { ref } from 'vue';
import type { FeatureView } from '../../shared/feature-contracts';
import type { PermissionPolicy } from '../../shared/permissions';

export const legacyMcpSwitches = [
  'readOnly',
  'allowIndex',
  'allowPublish',
  'allowToDoo',
  'allowToDooWrite',
] as const;
type LegacySwitch = (typeof legacyMcpSwitches)[number];
type McpValues = Record<LegacySwitch, boolean> & {
  oauthEnabled: boolean;
  apiKeyEnabled: boolean;
  externalWebOrigin: string;
  allowedPrefixes: string;
  toDooListIds: string[];
  toDooDomains: string[];
  permissionPolicy?: PermissionPolicy;
};
type Draft = { configVersion: number; values: McpValues; saved: string };

export const mcpSettingsDraft = ref<Draft>();
let session = 0;
export const mcpDraftSession = () => session;

export function loadMcpDraft(feature: FeatureView, expectedSession: number, discard = false) {
  if (expectedSession !== session) return;
  const current = mcpSettingsDraft.value;
  if (
    !discard &&
    current &&
    (current.configVersion === feature.configVersion || hasUnsavedMcpSettings())
  )
    return;
  const config = feature.config;
  const values = {
    ...structuredClone(config),
    allowedPrefixes: config.allowedPrefixes.join('\n'),
  } as McpValues;
  mcpSettingsDraft.value = {
    configVersion: feature.configVersion,
    values,
    saved: JSON.stringify(values),
  };
}

export function hasUnsavedMcpSettings() {
  const draft = mcpSettingsDraft.value;
  return !!draft && JSON.stringify(draft.values) !== draft.saved;
}

export function clearMcpSettings() {
  session++;
  mcpSettingsDraft.value = undefined;
}
