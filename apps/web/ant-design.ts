import type { App } from 'vue';
import { Alert, Button, Input } from 'ant-design-vue';
import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context';

export const antTheme: ThemeConfig = {
  token: {
    colorPrimary: '#4566c6',
    colorInfo: '#4566c6',
    colorSuccess: '#538775',
    colorWarning: '#ad8038',
    colorError: '#bf5258',
    colorText: '#262b36',
    colorTextSecondary: '#687486',
    colorBorder: '#dfe3eb',
    colorBgLayout: '#f5f6f8',
    borderRadius: 6,
    controlHeight: 36,
    fontSize: 13,
    fontFamily: 'Inter,"Noto Sans CJK SC","Microsoft YaHei",Arial,sans-serif',
    zIndexPopupBase: 1200,
  },
};

// Only the common form controls are global; pages import their other controls on demand.
// Do not load reset.css: Markdown and the editor have their own typography.
export function installAntDesign(app: App) {
  for (const component of [Alert, Button, Input]) {
    app.use(component);
  }
}
