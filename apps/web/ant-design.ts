import type { App } from 'vue';
import { Alert, Button, Input, theme } from 'ant-design-vue';
import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context';
import {
  applyPlatformCssVariables, platformAntTokens, toDooAntTokens,
  type PlatformThemeMode, type ToDooDensity,
} from './platform-theme';

export const antTheme: ThemeConfig = {
  token: platformAntTokens('light'),
};

export function toDooAntTheme(mode: PlatformThemeMode, density: ToDooDensity = 'comfortable'): ThemeConfig {
  return {
    algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: toDooAntTokens(mode, density),
  };
}

// Only the common form controls are global; pages import their other controls on demand.
// Do not load reset.css: Markdown and the editor have their own typography.
export function installAntDesign(app: App) {
  // Bootstrap before mount; App keeps this root mapping in sync with the theme.
  // Variables live on the document so Ant portals receive the same palette.
  if (typeof document !== 'undefined') applyPlatformCssVariables(document.documentElement, 'light');
  for (const component of [Alert, Button, Input]) {
    app.use(component);
  }
}
