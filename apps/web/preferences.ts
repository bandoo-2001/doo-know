import { reactive, readonly, ref, watch } from 'vue';
import type { EditorPreferences } from '../../shared/settings-contracts';
export type { EditorPreferences } from '../../shared/settings-contracts';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaults: EditorPreferences = {
  editorKind: 'document',
  mode: 'edit',
  wrap: true,
  lineNumbers: false,
  fontSize: 15,
  readingWidth: 'comfortable',
  theme: 'light',
};
const mutable = reactive<EditorPreferences>({ ...defaults });
export const editorPreferences = readonly(mutable);
export const editorPreferencesPersisted = ref(true);
export const editorSettingsDraft = reactive<EditorPreferences>({ ...defaults });
const fields = Object.keys(defaults) as (keyof EditorPreferences)[];

export function hasUnsavedEditorSettings() {
  return fields.some((key) => editorSettingsDraft[key] !== mutable[key]);
}

export function discardEditorSettingsDraft() {
  Object.assign(editorSettingsDraft, mutable);
}

function applySavedPreferences(next: EditorPreferences, discardDraft = false) {
  const changed = discardDraft ? {} : Object.fromEntries(
    fields.filter((key) => editorSettingsDraft[key] !== mutable[key])
      .map((key) => [key, editorSettingsDraft[key]]),
  );
  Object.assign(mutable, next);
  Object.assign(editorSettingsDraft, next, changed);
}

let storage: PreferenceStorage | undefined;
let accountKey = 'dooknow.preferences.v1:guest';
function normalize(value: Partial<EditorPreferences> | undefined): EditorPreferences {
  return {
    editorKind: value?.editorKind === 'document' || value?.editorKind === 'source' ? value.editorKind : value ? 'source' : 'document',
    mode: value?.editorKind === 'document' && value.mode === 'split' ? 'edit' : ['edit', 'preview', 'split'].includes(value?.mode || '') ? value!.mode! : defaults.mode,
    wrap: typeof value?.wrap === 'boolean' ? value.wrap : defaults.wrap,
    lineNumbers: typeof value?.lineNumbers === 'boolean' ? value.lineNumbers : defaults.lineNumbers,
    fontSize: [14, 15, 16, 18, 20].includes(value?.fontSize || 0)
      ? value!.fontSize!
      : defaults.fontSize,
    readingWidth: ['comfortable', 'wide', 'full'].includes(value?.readingWidth || '')
      ? value!.readingWidth!
      : defaults.readingWidth,
    theme: ['light', 'dark', 'system'].includes(value?.theme || '')
      ? value!.theme!
      : defaults.theme,
  };
}
export function initializeEditorPreferences(
  accountId: string,
  selectedStorage?: PreferenceStorage,
) {
  const previousAccount = accountKey;
  accountKey = 'dooknow.preferences.v1:' + encodeURIComponent(accountId || 'guest');
  try {
    storage = selectedStorage || (typeof localStorage !== 'undefined' ? localStorage : undefined);
  } catch {
    storage = undefined;
  }
  let value;
  try {
    value = JSON.parse(storage?.getItem(accountKey) || 'null');
    editorPreferencesPersisted.value = !!storage;
  } catch {
    editorPreferencesPersisted.value = false;
  }
  applySavedPreferences(normalize(value && typeof value === 'object' ? value : undefined), accountKey !== previousAccount);
}
export function setEditorPreferences(patch: Partial<EditorPreferences>) {
  applySavedPreferences(normalize({ ...mutable, ...patch, ...(patch.mode === 'split' && patch.editorKind === undefined ? {editorKind: 'source' as const} : {}) }));
  let saved = false;
  if (storage) {
    try {
      storage.setItem(accountKey, JSON.stringify(mutable));
      saved = true;
    } catch { /* The active page still uses the user's chosen display options. */ }
  }
  editorPreferencesPersisted.value = saved;
  return saved;
}
export function resetEditorPreferences() {
  applySavedPreferences(defaults, true);
  try {
    storage?.removeItem(accountKey);
    editorPreferencesPersisted.value = !!storage;
  } catch {
    editorPreferencesPersisted.value = false;
  }
}
const systemDark =
  typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
export const resolvedTheme = ref<'light' | 'dark'>('light');
function applyAppearance() {
  resolvedTheme.value =
    mutable.theme === 'system' ? (systemDark?.matches ? 'dark' : 'light') : mutable.theme;
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = resolvedTheme.value;
  document.documentElement.style.setProperty('--editor-font-size', mutable.fontSize + 'px');
  document.documentElement.style.setProperty(
    '--reading-width',
    mutable.readingWidth === 'full' ? 'none' : mutable.readingWidth === 'wide' ? '1080px' : '860px',
  );
  document.documentElement.style.setProperty(
    '--reading-content-width',
    mutable.readingWidth === 'full' ? '100%' : mutable.readingWidth === 'wide' ? '1016px' : '796px',
  );
}
watch(mutable, applyAppearance, { immediate: true });
systemDark?.addEventListener('change', applyAppearance);
