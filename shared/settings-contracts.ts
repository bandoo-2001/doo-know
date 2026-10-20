export type SettingsSection =
  | 'editor'
  | 'library'
  | 'search'
  | 'backup'
  | 'plugins'
  | 'account'
  | 'about';
export interface EditorPreferences {
  editorKind: 'document' | 'source';
  mode: 'edit' | 'preview' | 'split';
  wrap: boolean;
  lineNumbers: boolean;
  fontSize: 14 | 15 | 16 | 18 | 20;
  readingWidth: 'comfortable' | 'wide' | 'full';
  theme: 'light' | 'dark' | 'system';
}
