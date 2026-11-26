import type { FeatureId } from './feature-config.js';

export interface FeatureView {
  id: FeatureId;
  desiredEnabled: boolean;
  state: 'disabled' | 'starting' | 'enabled' | 'stopping' | 'failed';
  configVersion: number;
  config: Record<string, any>;
  error?: string;
}

export interface FeatureCallInput {
  kind: 'command' | 'provider';
  id: string;
  input?: unknown;
  requestId?: string;
}

export interface FeatureStorage {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  entries<T>(prefix?: string): { key: string; value: T }[];
}
