export interface AppConfig {
  knowledgeRoot: string;
  dataRoot: string;
  secret: string;
  origin: string;
  port?: number;
  host?: string;
  staticRoot?: string;
  agent?: import('./knowledge-contracts.js').AgentConfig;
  vectorServiceUrl?: string;
  vectorServiceToken?: string;
  embeddingSpaceId?: string;
  indexing?: { enabled?: boolean; watch?: boolean };
}
export interface NoteDocument {
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
  id?: string;
  name: string;
  path: string;
  type: 'folder' | 'note';
  updatedAt?: string;
  children?: TreeEntry[];
}
