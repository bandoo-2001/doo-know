export const HOST_PLUGIN_API = '1.3.0';
export type ContributionSlot = 'navigation' | 'settingsPage' | 'fileDecoration' | 'noteAction' | 'notePanel' | 'libraryAction';
export interface Contribution {
  id: string; slot: ContributionSlot; title: string; command?: string; provider?: string;
  component?: string; when?: { key: string; equals: string | number | boolean }[];
}
export interface PluginManifest {
  id: string; version: string; apiVersion: string; title: string;
  capabilities: string[]; server: string; web?: string;
  styles?: string[];
  configSchema: Record<string, any>; contributions: Contribution[];
  configurationRequiresRestart?: boolean;
}
export interface PluginCatalogEntry extends PluginManifest {
  description: string; artifact: { url: string; sha256: string };
}
export interface PluginCallInput { kind: 'command' | 'provider'; id: string; input: unknown; requestId?: string }
export interface PluginStorage {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  entries<T = unknown>(prefix?: string): { key: string; value: T }[];
}
export interface PluginDataDependency {
  id: string; title: string; version?: string; apiVersion?: string;
  state: 'missing' | 'unavailable' | 'disabled' | 'enabled' | 'version_mismatch' | 'incompatible' | 'invalid';
  installedVersion?: string; installAvailable: boolean;
}
export interface PluginView {
  id: string; installedVersion: string; activeVersion?: string; desiredEnabled: boolean;
  configVersion: number; state: 'disabled' | 'starting' | 'enabled' | 'stopping' | 'failed';
  restartRequired: boolean; error?: string; manifest: PluginManifest;
  activeManifest?: PluginManifest; webUrl?: string;
  config: Record<string, unknown>; configuredSecrets: string[];
}
