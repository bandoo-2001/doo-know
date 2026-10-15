import type { Component } from 'vue';
export { NButton, NInput, NAlert, NCard, NSelect, NCheckbox, NInputNumber, NSwitch, NSpin } from 'naive-ui';
export interface PluginUIApi {
  readonly pluginId: string;
  readonly apiVersion: '1.0.0';
  registerComponent(id: string, component: Component): () => void;
  call<T = any>(kind: 'command' | 'provider', id: string, input: unknown, requestId?: string): Promise<T>;
  openPanel(id: string, context?: Record<string, unknown>): void;
  notifyChanged(noteId?: string): void;
  notify(message: string): void;
}
