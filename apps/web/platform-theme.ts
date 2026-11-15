import type { GlobalThemeOverrides } from 'naive-ui';
import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context';

export type PlatformThemeMode = 'light' | 'dark';
export type ToDooDensity = 'comfortable' | 'compact';
const uiFont = 'Inter,"Noto Sans CJK SC","Microsoft YaHei",Arial,sans-serif';

// Framework tokens mirror the existing ToDoo CSS vocabulary. Content colors and
// document/reading preferences remain owned by their respective renderers.
export const platformPalette = {
  light: {
    background: '#ffffff', paper: '#ffffff', soft: '#f7f8fa',
    ink: '#272b3a', muted: '#657084', line: '#e6e9f1',
    accent: '#4566c6', tint: '#edf1ff', hover: '#5676d4', pressed: '#3453ac',
    success: '#438674', warning: '#a47939', danger: '#b75b66', onAccent: '#ffffff',
    disabled: '#8f96a5',
    priorityHigh: '#c83239', priorityNormal: '#a95b12', priorityLow: '#2767bf',
    priorityNone: '#657184', matrixLater: '#237954',
    shadow: '0 8px 28px #17233a16', scrim: '#1f223d38',
  },
  dark: {
    background: '#13151e', paper: '#1b1e29', soft: '#252937',
    ink: '#e5e8f0', muted: '#a1a9bb', line: '#323746',
    accent: '#8ba4ff', tint: '#25334d', hover: '#a4b6ff', pressed: '#7188e8',
    success: '#8bcaaf', warning: '#dbb884', danger: '#eea1ac', onAccent: '#13151e',
    disabled: '#687083',
    priorityHigh: '#ff9399', priorityNormal: '#ffc078', priorityLow: '#8cbaff',
    priorityNone: '#aab4c5', matrixLater: '#7bd7ac',
    shadow: '0 8px 28px #00000052', scrim: '#080b145c',
  },
} as const;

// Platform chrome stays at 13px. ToDoo is an explicit scope of this same scale;
// reading/editor typography and user-authored colors remain separate.
export const platformUiScale = { fontSize: 13, radius: 8, controlHeight: 36 } as const;
export const toDooUiScale = {
  fontSize: 14, lineHeight: 22, captionSize: 12, captionLineHeight: 18,
  headingSize: 20, headingLineHeight: 28, sectionSize: 16, detailTitleSize: 22,
  detailTitleLineHeight: 30, detailPadding: 20, propertyLabelWidth: 72,
  radius: platformUiScale.radius, controlRadius: 6, tagRadius: 4,
  controlHeight: 36, compactControlHeight: 32, touchTarget: 44,
  rowHeight: 40, compactRowHeight: 36, rowPadding: 4, compactRowPadding: 2,
  navHeight: 40, compactNavHeight: 36, navWidth: 200, collapsedNavWidth: 56,
  primaryNavWidth: 64, globalHeaderHeight: 56, detailWidth: 400, detailMinWidth: 360,
  listMinWidth: 440, pagePadding: 24, narrowPagePadding: 16,
  headerHeight: 48, detailFooterHeight: 56, iconButtonSize: 32, iconSize: 18,
  iconSmallSize: 16, iconGap: 6, focusWidth: 2, focusOffset: 2,
  motionFast: 120, motionPanel: 180, popupBase: 1200,
} as const;

function semanticText(seed: string, ink: string) {
  const channels = (value: string) => value.slice(1).match(/../g)!.map((c) => parseInt(c, 16));
  const foreground = channels(seed), background = channels(ink);
  return '#' + foreground.map((c, i) =>
    Math.round(c * 0.7 + background[i] * 0.3).toString(16).padStart(2, '0'),
  ).join('');
}

export function platformAntTokens(mode: PlatformThemeMode): NonNullable<ThemeConfig['token']> {
  const p = platformPalette[mode];
  return {
    colorPrimary: p.accent, colorInfo: p.accent,
    colorPrimaryHover: p.hover, colorPrimaryActive: p.pressed,
    colorSuccess: p.success, colorWarning: p.warning, colorError: p.danger,
    colorSuccessText: semanticText(p.success, p.ink),
    colorWarningText: semanticText(p.warning, p.ink), colorErrorText: semanticText(p.danger, p.ink),
    colorText: p.ink, colorTextSecondary: p.muted, colorTextLightSolid: p.onAccent,
    colorTextTertiary: p.muted, colorTextDisabled: p.disabled,
    colorBorder: p.line, colorBorderSecondary: p.line, colorSplit: p.line,
    colorBgLayout: p.soft, colorBgContainer: p.paper, colorBgElevated: p.paper,
    colorPrimaryBg: p.tint, colorFillAlter: p.soft,
    borderRadius: platformUiScale.radius, controlHeight: platformUiScale.controlHeight,
    fontSize: platformUiScale.fontSize, fontFamily: uiFont,
    zIndexPopupBase: toDooUiScale.popupBase,
  };
}

export function toDooAntTokens(
  mode: PlatformThemeMode,
  density: ToDooDensity = 'comfortable',
): NonNullable<ThemeConfig['token']> {
  const s = toDooUiScale;
  return {
    ...platformAntTokens(mode),
    fontSize: s.fontSize, fontSizeSM: s.captionSize, fontSizeLG: s.sectionSize,
    lineHeight: s.lineHeight / s.fontSize, borderRadius: s.radius,
    borderRadiusSM: s.controlRadius,
    controlHeight: density === 'compact' ? s.compactControlHeight : s.controlHeight,
    controlHeightSM: s.compactControlHeight, controlHeightLG: s.touchTarget,
  };
}

/** The same values feed framework tokens, page CSS and body-mounted portals. */
export function toDooCssVariables(mode: PlatformThemeMode): Record<string, string> {
  const p = platformPalette[mode], s = toDooUiScale;
  const px = (value: number) => `${value}px`;
  return {
    '--todo-font-family': uiFont,
    '--todo-bg': p.background, '--todo-paper': p.paper, '--todo-soft': p.soft,
    '--todo-ink': p.ink, '--todo-muted': p.muted, '--todo-disabled': p.disabled,
    '--todo-line': p.line, '--todo-accent': p.accent, '--todo-tint': p.tint,
    '--todo-accent-hover': p.hover, '--todo-accent-active': p.pressed,
    '--todo-green': p.success, '--todo-warning': p.warning, '--todo-danger': p.danger,
    '--todo-on-accent': p.onAccent,
    '--todo-success-text': semanticText(p.success, p.ink),
    '--todo-warning-text': semanticText(p.warning, p.ink),
    '--todo-danger-text': semanticText(p.danger, p.ink),
    '--todo-priority-red': p.priorityHigh, '--todo-priority-orange': p.priorityNormal,
    '--todo-priority-blue': p.priorityLow, '--todo-priority-gray': p.priorityNone,
    '--todo-matrix-green': p.matrixLater, '--todo-shadow': p.shadow, '--todo-scrim': p.scrim,
    '--todo-primary-nav-width': px(s.primaryNavWidth),
    '--todo-global-header-height': px(s.globalHeaderHeight),
    '--todo-context-nav-width': px(s.navWidth), '--todo-collapsed-nav-width': px(s.collapsedNavWidth),
    '--todo-detail-width': px(s.detailWidth), '--todo-detail-min-width': px(s.detailMinWidth),
    '--todo-list-min-width': px(s.listMinWidth), '--todo-page-padding': px(s.pagePadding),
    '--todo-narrow-page-padding': px(s.narrowPagePadding),
    '--todo-radius': px(s.radius), '--todo-control-radius': px(s.controlRadius),
    '--todo-tag-radius': px(s.tagRadius), '--todo-font-size': px(s.fontSize),
    '--todo-body-line-height': px(s.lineHeight), '--todo-heading-size': px(s.headingSize),
    '--todo-heading-line-height': px(s.headingLineHeight), '--todo-section-size': px(s.sectionSize),
    '--todo-item-size': px(s.fontSize), '--todo-caption-size': px(s.captionSize),
    '--todo-caption-line-height': px(s.captionLineHeight), '--todo-detail-title-size': px(s.detailTitleSize),
    '--todo-detail-title-line-height': px(s.detailTitleLineHeight),
    '--todo-detail-padding': px(s.detailPadding), '--todo-property-label-width': px(s.propertyLabelWidth),
    '--todo-comfort-control-height': px(s.controlHeight),
    '--todo-compact-control-height': px(s.compactControlHeight),
    '--todo-comfort-row-height': px(s.rowHeight), '--todo-compact-row-height': px(s.compactRowHeight),
    '--todo-comfort-row-padding': px(s.rowPadding), '--todo-compact-row-padding': px(s.compactRowPadding),
    '--todo-comfort-nav-height': px(s.navHeight), '--todo-compact-nav-height': px(s.compactNavHeight),
    '--todo-header-height': px(s.headerHeight), '--todo-detail-footer-height': px(s.detailFooterHeight),
    '--todo-icon-button-size': px(s.iconButtonSize), '--todo-touch-target': px(s.touchTarget),
    '--todo-icon-size': px(s.iconSize), '--todo-icon-small-size': px(s.iconSmallSize),
    '--todo-icon-gap': px(s.iconGap), '--todo-focus-width': px(s.focusWidth),
    '--todo-focus-offset': px(s.focusOffset), '--todo-motion-fast-base': `${s.motionFast}ms`,
    '--todo-motion-panel-base': `${s.motionPanel}ms`,
    ...Object.fromEntries([4, 8, 12, 16, 24, 32].map((value) => [`--todo-space-${value}`, px(value)])),
  };
}

export function applyPlatformCssVariables(
  target: { style: Pick<CSSStyleDeclaration, 'setProperty'> }, mode: PlatformThemeMode,
) {
  for (const [name, value] of Object.entries(toDooCssVariables(mode))) target.style.setProperty(name, value);
}

export function platformNaiveOverrides(mode: PlatformThemeMode): GlobalThemeOverrides {
  const p = platformPalette[mode];
  return {
    common: {
      primaryColor: p.accent, primaryColorSuppl: p.accent,
      primaryColorHover: p.hover, primaryColorPressed: p.pressed,
      successColor: p.success, warningColor: p.warning, errorColor: p.danger,
      bodyColor: p.background, cardColor: p.paper, modalColor: p.paper,
      popoverColor: p.paper, inputColor: p.paper, hoverColor: p.soft,
      textColorBase: p.ink, textColor1: p.ink, textColor2: p.ink, textColor3: p.muted,
      borderColor: p.line, dividerColor: p.line, borderRadius: `${platformUiScale.radius}px`, fontFamily: uiFont,
      scrollbarColor: 'var(--scrollbar-thumb)',
      scrollbarColorHover: 'var(--scrollbar-thumb-hover)', scrollbarWidth: '6px', scrollbarHeight: '6px',
    },
    Input: {
      color: p.paper, colorFocus: p.paper,
      border: `1px solid ${p.line}`, borderHover: `1px solid ${p.accent}`,
      boxShadowFocus: `0 0 0 3px ${p.accent}1a`,
    },
    Card: { borderColor: p.line, borderRadius: `${platformUiScale.radius}px`, titleFontSizeMedium: '17px', titleFontWeight: '600', paddingMedium: '24px' },
    Select: { peers: { InternalSelection: { border: `1px solid ${p.line}`, color: p.paper } } },
    Button: {
      fontWeight: '500', textColorPrimary: p.onAccent, textColorHoverPrimary: p.onAccent,
      textColorPressedPrimary: p.onAccent, textColorFocusPrimary: p.onAccent,
    },
  };
}
