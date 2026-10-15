export { mutationCore, webPrincipal } from './knowledge/core.js';
export { noteService } from './notes.js';
export { assetService } from './assets.js';
export { recoveryService } from './recovery.js';
export { shareService } from './shares.js';
export { openDatabase, type AppDatabase } from './db.js';
export { workspaceWrite, workspaceExclusive } from './workspace/gate.js';
export type {
  Principal,
  NoteInfo,
  SourceVersion,
  SearchInput,
  SearchOutput,
} from '../../shared/knowledge-contracts.js';
