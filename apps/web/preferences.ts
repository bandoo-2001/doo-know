import { reactive, readonly, ref, watch } from 'vue';
import type { EditorPreferences } from '../../shared/settings-contracts';
export type { EditorPreferences } from '../../shared/settings-contracts';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaults: EditorPreferences = {
  mode: 'edit',
  wrap: true,
  lineNumbers: false,
  fontSize: 15,
  readingWidth: 'comfortable',
  theme: 'light',
};
const mutable = reactive<EditorPreferences>({ ...defaults });
export const editorPreferences = readonly(mutable);
let storage: PreferenceStorage | undefined;
let accountKey = 'dooknow.preferences.v1:guest';
function normalize(value: Partial<EditorPreferences> | undefined): EditorPreferences {
  return {
    mode: ['edit', 'preview', 'split'].includes(value?.mode || '') ? value!.mode! : defaults.mode,
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
  accountKey = 'dooknow.preferences.v1:' + encodeURIComponent(accountId || 'guest');
  try {
    storage = selectedStorage || (typeof localStorage !== 'undefined' ? localStorage : undefined);
  } catch {
    storage = undefined;
  }
  let value;
  try {
    value = JSON.parse(storage?.getItem(accountKey) || 'null');
  } catch {}
  Object.assign(mutable, normalize(value && typeof value === 'object' ? value : undefined));
}
export function setEditorPreferences(patch: Partial<EditorPreferences>) {
  Object.assign(mutable, normalize({ ...mutable, ...patch }));
  try {
    storage?.setItem(accountKey, JSON.stringify(mutable));
  } catch {}
}
export function resetEditorPreferences() {
  Object.assign(mutable, defaults);
  try {
    storage?.removeItem(accountKey);
  } catch {}
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
