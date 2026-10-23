export interface AppConfig {
  knowledgeRoot: string;
  dataRoot: string;
  secret: string;
  origin: string;
  port?: number;
  host?: string;
  staticRoot?: string;
  agent?: import('./knowledge-contracts.js').AgentConfig;
  agentConfigFile?: string;
  vectorRuntimeRoot?: string;
  modelDir?: string;
  tokenizerPython?: string;
  vectorServiceUrl?: string;
  vectorServiceToken?: string;
  embeddingSpaceId?: string;
  indexing?: { enabled?: boolean; watch?: boolean; embedded?: boolean };
  fileTasks?: { embedded?: boolean };
  gitSyncEnabled?: boolean;
}
export interface NoteDocument {
  documentType?: 'markdown' | 'whiteboard';
  id: string;
  title: string;
  relativePath: string;
  content: string;
  modifiedAt: string;
  updatedAt: string;
  shared?: boolean;
  html?: string;
}
export interface TreeEntry {
  documentType?: 'markdown' | 'whiteboard';
  id?: string;
  name: string;
  path: string;
  type: 'folder' | 'note';
  updatedAt?: string;
  favorite?: boolean;
  children?: TreeEntry[];
}
