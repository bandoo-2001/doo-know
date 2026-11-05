import type { GlobalThemeOverrides } from 'naive-ui';
import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context';

type Mode = 'light' | 'dark';
const uiFont = 'Inter,"Noto Sans CJK SC","Microsoft YaHei",Arial,sans-serif';

// Framework tokens mirror the existing ToDoo CSS vocabulary. Content colors and
// document/reading preferences remain owned by their respective renderers.
export const platformPalette = {
  light: {
    background: '#ffffff', paper: '#ffffff', soft: '#f7f8fa',
    ink: '#272b3a', muted: '#657084', line: '#e6e9f1',
    accent: '#4566c6', tint: '#edf1ff', hover: '#5676d4', pressed: '#3453ac',
    success: '#438674', warning: '#a47939', danger: '#b75b66', onAccent: '#ffffff',
  },
  dark: {
    background: '#13151e', paper: '#1b1e29', soft: '#252937',
    ink: '#e5e8f0', muted: '#a1a9bb', line: '#323746',
    accent: '#8ba4ff', tint: '#25334d', hover: '#a4b6ff', pressed: '#7188e8',
    success: '#8bcaaf', warning: '#dbb884', danger: '#eea1ac', onAccent: '#13151e',
  },
} as const;

export function platformAntTokens(mode: Mode): NonNullable<ThemeConfig['token']> {
  const p = platformPalette[mode];
  return {
    colorPrimary: p.accent, colorInfo: p.accent,
    colorSuccess: p.success, colorWarning: p.warning, colorError: p.danger,
    colorText: p.ink, colorTextSecondary: p.muted, colorTextLightSolid: p.onAccent,
    colorBorder: p.line, colorBorderSecondary: p.line, colorSplit: p.line,
    colorBgLayout: p.soft, colorBgContainer: p.paper, colorBgElevated: p.paper,
    colorPrimaryBg: p.tint, colorFillAlter: p.soft,
    borderRadius: 8, controlHeight: 36, fontSize: 13, fontFamily: uiFont,
    zIndexPopupBase: 1200,
  };
}

export function platformNaiveOverrides(mode: Mode): GlobalThemeOverrides {
  const p = platformPalette[mode];
  return {
    common: {
      primaryColor: p.accent, primaryColorSuppl: p.accent,
      primaryColorHover: p.hover, primaryColorPressed: p.pressed,
      successColor: p.success, warningColor: p.warning, errorColor: p.danger,
      bodyColor: p.background, cardColor: p.paper, modalColor: p.paper,
      popoverColor: p.paper, inputColor: p.paper, hoverColor: p.soft,
      textColorBase: p.ink, textColor1: p.ink, textColor2: p.ink, textColor3: p.muted,
      borderColor: p.line, dividerColor: p.line, borderRadius: '8px', fontFamily: uiFont,
      scrollbarColor: 'var(--scrollbar-thumb)',
      scrollbarColorHover: 'var(--scrollbar-thumb-hover)', scrollbarWidth: '6px', scrollbarHeight: '6px',
    },
    Input: {
      color: p.paper, colorFocus: p.paper,
      border: `1px solid ${p.line}`, borderHover: `1px solid ${p.accent}`,
      boxShadowFocus: `0 0 0 3px ${p.accent}1a`,
    },
    Card: { borderColor: p.line, borderRadius: '8px', titleFontSizeMedium: '17px', titleFontWeight: '600', paddingMedium: '24px' },
    Select: { peers: { InternalSelection: { border: `1px solid ${p.line}`, color: p.paper } } },
    Button: {
      fontWeight: '500', textColorPrimary: p.onAccent, textColorHoverPrimary: p.onAccent,
      textColorPressedPrimary: p.onAccent, textColorFocusPrimary: p.onAccent,
    },
  };
}
