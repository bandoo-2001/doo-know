import type { App } from 'vue';
import { Alert, Button, Input } from 'ant-design-vue';
import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context';
import { platformAntTokens } from './platform-theme';

export const antTheme: ThemeConfig = {
  token: platformAntTokens('light'),
};

// Only the common form controls are global; pages import their other controls on demand.
// Do not load reset.css: Markdown and the editor have their own typography.
export function installAntDesign(app: App) {
  for (const component of [Alert, Button, Input]) {
    app.use(component);
  }
}
