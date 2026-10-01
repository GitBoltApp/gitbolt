import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, readThemeMirror, resolveColors, THEME_STORAGE_KEY, writeThemeMirror } from './apply';
import { useTheme } from './store';
import { COLOR_TOKENS, THEMES } from './themes';

describe('useTheme', () => {
  beforeEach(() => useTheme.getState().set('default-dark', {}));

  it('applies every color token and lane color to :root', () => {
    useTheme.getState().set('nord', {});
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--app-bg0')).toBe('#2e3440');
    expect(style.getPropertyValue('--graph-0')).toBe('#88c0d0');
    for (const t of COLOR_TOKENS) expect(style.getPropertyValue(`--${t}`), t).toBe(THEMES.nord.colors[t]);
    expect(document.documentElement.dataset.theme).toBe('nord');
    expect(style.colorScheme).toBe('dark');
    useTheme.getState().set('light', {});
    expect(style.colorScheme).toBe('light');
  });

  it('bumps version on every change so canvases redraw', () => {
    const v = useTheme.getState().version;
    useTheme.getState().set('monokai', {});
    expect(useTheme.getState().version).toBe(v + 1);
  });

  it('applies lane overrides only to their own theme and ignores invalid ones', () => {
    useTheme.getState().set('nord', { nord: ['#123456', null, 'not-a-color'], light: ['#abcdef'] });
    const g = useTheme.getState().colors.graph;
    expect(g[0]).toBe('#123456');
    expect(g[1]).toBe(THEMES.nord.graph[1]);
    expect(g[2]).toBe(THEMES.nord.graph[2]);
    expect(document.documentElement.style.getPropertyValue('--graph-0')).toBe('#123456');
    expect(resolveColors(THEMES.light, ['#abcdef']).graph[0]).toBe('#abcdef');
    expect(resolveColors(THEMES.light, ['#ABCDEF']).graph[0]).toBe('#abcdef');
  });

  it("resolves the canvas colors from the theme's tokens", () => {
    expect(resolveColors(THEMES.light)).toEqual({
      nodeFill: THEMES.light.colors['node-fill'], nodeText: THEMES.light.colors['node-text'], collapseStrip: THEMES.light.colors['collapse-strip'], graph: [...THEMES.light.graph],
      laneText: expect.any(Array),
    });
  });

  it('picks avatar initials per lane by contrast, overrides included; Default Dark keeps white on every lane', () => {
    expect(resolveColors(THEMES['default-dark']).laneText).toEqual(Array(10).fill('#ffffff'));
    const d = resolveColors(THEMES.darcula, [null, null, null, null, '#ffffff', '#000000']);
    expect(d.laneText[4]).toBe(THEMES.darcula.colors['app-bg0']);
    expect(d.laneText[5]).toBe('#ffffff');
    // #ffc66d, Darcula's yellow lane: dark initials.
    expect(resolveColors(THEMES.darcula).laneText[4]).toBe('#2b2b2b');
  });

  it('an unknown id falls back to Default Dark', () => {
    useTheme.getState().set('no-such-theme' as never, {});
    expect(useTheme.getState().id).toBe('default-dark');
  });
});

describe('the first-paint mirror (R3)', () => {
  beforeEach(() => localStorage.clear());

  it("round-trips the theme and its own lane overrides, with the kind and background index.html paints", () => {
    writeThemeMirror('nord', ['#123456', null]);
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toEqual({ id: 'nord', kind: 'dark', bg: '#2e3440', graph: ['#123456', null] });
    expect(readThemeMirror()).toEqual({ id: 'nord', graph: ['#123456', null] });
  });

  it('ignores a missing, corrupt or unknown mirror', () => {
    expect(readThemeMirror()).toBeNull();
    localStorage.setItem(THEME_STORAGE_KEY, '{nope');
    expect(readThemeMirror()).toBeNull();
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ id: 'solarized' }));
    expect(readThemeMirror()).toBeNull();
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ id: 'nord', graph: 'x' }));
    expect(readThemeMirror()).toEqual({ id: 'nord', graph: undefined });
  });

  it('applyTheme writes onto the element it is given', () => {
    const el = document.createElement('div');
    applyTheme(el, THEMES.dracula, resolveColors(THEMES.dracula));
    expect(el.style.getPropertyValue('--app-bg0')).toBe('#282a36');
    expect(el.dataset.theme).toBe('dracula');
  });
});
