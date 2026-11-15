import { describe, expect, test } from 'vitest';
import {
  applyPlatformCssVariables,
  platformAntTokens,
  platformPalette,
  toDooAntTokens,
  toDooCssVariables,
  toDooUiScale,
  type PlatformThemeMode,
} from '../apps/web/platform-theme';

function luminance(hex: string) {
  const [r, g, b] = hex.slice(1).match(/../g)!.map((part) => {
    const value = parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe.each<PlatformThemeMode>(['light', 'dark'])('shared theme in %s mode', (mode) => {
  test('Ant controls and body-mounted portals receive the same semantic palette', () => {
    const ant = toDooAntTokens(mode), css = toDooCssVariables(mode);
    expect(css['--todo-accent']).toBe(ant.colorPrimary);
    expect(css['--todo-paper']).toBe(ant.colorBgContainer);
    expect(css['--todo-tint']).toBe(ant.colorPrimaryBg);
    expect(css['--todo-ink']).toBe(ant.colorText);
    expect(css['--todo-muted']).toBe(ant.colorTextSecondary);
    expect(css['--todo-danger-text']).toBe(ant.colorErrorText);
    expect(css['--todo-warning-text']).toBe(ant.colorWarningText);
    expect(css['--todo-success-text']).toBe(ant.colorSuccessText);
    expect(css['--todo-priority-red']).toBe(platformPalette[mode].priorityHigh);
  });

  test('small semantic text stays readable on both content and hover surfaces', () => {
    const css = toDooCssVariables(mode);
    for (const role of ['ink', 'muted', 'success-text', 'warning-text', 'danger-text']) {
      for (const surface of ['paper', 'soft']) {
        expect(contrast(css[`--todo-${role}`], css[`--todo-${surface}`]), `${role} on ${surface}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('density changes geometry without shrinking ToDoo text or platform typography', () => {
    const platform = platformAntTokens(mode);
    const comfortable = toDooAntTokens(mode), compact = toDooAntTokens(mode, 'compact');
    const css = toDooCssVariables(mode);
    expect(platform.fontSize).toBe(13);
    expect(comfortable.fontSize).toBe(14);
    expect(compact.fontSize).toBe(comfortable.fontSize);
    expect(compact.lineHeight).toBe(comfortable.lineHeight);
    expect(`${comfortable.controlHeight}px`).toBe(css['--todo-comfort-control-height']);
    expect(`${compact.controlHeight}px`).toBe(css['--todo-compact-control-height']);
    expect(toDooUiScale.compactRowHeight).toBeLessThan(toDooUiScale.rowHeight);
    expect(toDooUiScale.touchTarget).toBeGreaterThanOrEqual(44);
    expect(toDooUiScale.iconButtonSize + toDooUiScale.rowPadding * 2).toBeLessThanOrEqual(toDooUiScale.rowHeight);
    expect(toDooUiScale.iconButtonSize + toDooUiScale.compactRowPadding * 2).toBeLessThanOrEqual(toDooUiScale.compactRowHeight);
    expect(platformAntTokens(mode)).toEqual(platform);
  });
});

test('theme switches replace document variables used by portals as well as page content', () => {
  const properties = new Map<string, string>();
  const target = { style: { setProperty: (name: string, value: string) => { properties.set(name, value); } } };
  applyPlatformCssVariables(target, 'light');
  expect(properties.get('--todo-paper')).toBe(platformPalette.light.paper);
  applyPlatformCssVariables(target, 'dark');
  expect(Object.fromEntries(properties)).toEqual(toDooCssVariables('dark'));
  expect([...properties.values()].every((value) => value.length > 0)).toBe(true);
});
