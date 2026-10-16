import type { AppConfig } from './contracts.js';

export interface SearchDistribution {
  version: string;
  pythonVersion: string;
  platform: 'linux-x64';
  spaceId: string;
  modelRevision: string;
  url: string;
  sha256: string;
  bytes: number;
}
export interface HostConfig extends Omit<AppConfig, 'knowledgeRoot'> {
  knowledgeRoot?: string;
  allowedKnowledgeBases?: string[];
  secretFile?: string;
  applicationRoot?: string;
  profileFile?: string;
  pluginCatalog?: import('../packages/plugin-contracts/index.js').PluginCatalogEntry[];
  pluginRoot?: string;
  serviceName?:string;
  serviceManaged?:boolean;
  installRoot?:string;
  distribution?: { repository: string; tokenFile: string };
  vectorServiceTokenFile?:string;
  searchDistribution?: SearchDistribution;
  searchRuntimeRoot?: string;
  searchModelsRoot?: string;
  searchCacheRoot?: string;
}
export type PlatformPhase =
  | 'owner_required'
  | 'setup_required'
  | 'initializing'
  | 'ready'
  | 'source_unavailable'
  | 'configuration_error';
export interface PlatformStatus {
  phase: PlatformPhase;
  setupRequired: boolean;
  configurationSource: 'deployment' | 'application' | 'none';
  knowledgeRoot?: string;
  timeZone: string;
  bindingVersion: number;
  onboardingRequired?: boolean;
  allowedKnowledgeBases?: string[];
  components: { knowledge: boolean; search: boolean };
  code?: string;
}
