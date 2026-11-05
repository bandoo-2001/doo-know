import type { BrowserContext, Locator, Page } from '@playwright/test';

export type Variant = {
  id: string; width: number; height: number; theme: 'light' | 'dark';
  hasTouch?: boolean; isMobile?: boolean; representative?: boolean;
};
export const variants: Variant[] = [
  { id: '1440-light', width: 1440, height: 1000, theme: 'light' },
  { id: '390-light', width: 390, height: 844, theme: 'light', hasTouch: true, isMobile: true },
  { id: '320-light', width: 320, height: 844, theme: 'light', hasTouch: true, isMobile: true },
  { id: '1440-dark', width: 1440, height: 1000, theme: 'dark', representative: true },
  { id: '390-dark', width: 390, height: 844, theme: 'dark', hasTouch: true, isMobile: true, representative: true },
  { id: '820-portrait', width: 820, height: 1180, theme: 'light', hasTouch: true, isMobile: true, representative: true },
  { id: '844-short', width: 844, height: 390, theme: 'light', hasTouch: true, isMobile: true, representative: true },
  { id: '360-short-dark', width: 360, height: 460, theme: 'dark', hasTouch: true, isMobile: true, representative: true },
];

export type Fixture = {
  origin: string; dataRoot: string; knowledgeRoot: string; graphModelURL?: string;
  userId: string; noteId: string; secondNoteId: string; noteContent: string;
  privateNoteId: string; revokedNoteId: string; expiredNoteId: string;
  publicSlug: string; collectionSlug: string; shares: string[]; oauthPath?: string;
  api: (path: string, method?: string, data?: unknown) => Promise<any>;
  setTemplate: (template: string) => Promise<void>;
  setup?: { fixtureId: string; libraryParent: string; existingRoot: string; gitRemoteURL: string; releaseGit?: () => Promise<void> };
};
export type SceneEnv = { page: Page; context: BrowserContext; fixture: Fixture; variant: Variant };
export type Scene = {
  id: string; sourceIds: string[]; title: string; state: string;
  role: 'owner' | 'anonymous' | 'guest-editor' | 'public-reader';
  readiness?: 'target';
  suite?: 'main' | 'setup';
  setupMode?: 'empty' | 'source-unavailable' | 'git-delayed';
  evidenceKind?: 'downloaded-html';
  path: string | ((fixture: Fixture) => string);
  target: string | ((page: Page) => Locator);
  open?: (env: SceneEnv) => Promise<void>;
  before?: (env: SceneEnv) => Promise<void>;
  verify?: (env: SceneEnv) => Promise<unknown>;
  afterCapture?: (env: SceneEnv) => Promise<unknown>;
  requires?: 'document-editor' | 'graph-model';
  representative?: boolean;
  widths?: number[];
  window?: boolean;
  fault?: string;
  tests: string[];
  // Exact inventory strings only; an omitted important state remains untested.
  importantStates?: Record<string, string[]>;
};
