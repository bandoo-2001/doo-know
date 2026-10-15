import type { AppConfig } from './contracts.js';

export interface HostConfig extends Omit<AppConfig, 'knowledgeRoot'> {
  knowledgeRoot?: string;
  allowedKnowledgeBases?: string[];
  secretFile?: string;
  applicationRoot?: string;
  profileFile?: string;
}
export type PlatformPhase = 'owner_required' | 'setup_required' | 'initializing' | 'ready'
  | 'source_unavailable' | 'configuration_error';
export interface PlatformStatus {
  phase: PlatformPhase;
  setupRequired: boolean;
  configurationSource: 'deployment' | 'application' | 'none';
  knowledgeRoot?: string;
  timeZone: string;
  bindingVersion: number;
  components: { knowledge: boolean; search: boolean };
  code?: string;
}
