import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppSettings } from '../api/gen/AppSettings';
import { DEFAULT_SETTINGS, useAppState } from '../app/state';
import { THEME_STORAGE_KEY } from './apply';
import { bindThemeToSettings } from './bind';
import { useTheme } from './store';

const settle = (patch: Partial<AppSettings>, loaded = true) => act(() => useAppState.setState((s) => ({ loaded, settings: { ...s.settings, ...patch } })));

describe('bindThemeToSettings', () => {
  let unbind: (() => void) | undefined;
  beforeEach(() => {
    localStorage.clear();
    useAppState.setState({ loaded: false, settings: DEFAULT_SETTINGS });
    act(() => useTheme.getState().set('default-dark', {}));
  });
  afterEach(() => { unbind?.(); unbind = undefined; history.replaceState(null, '', '/'); });

  it('applies the saved theme at startup and follows later changes', () => {
    settle({ theme: 'dracula', graphColorOverrides: {} });
    unbind = bindThemeToSettings();
    expect(useTheme.getState().id).toBe('dracula');
    settle({ theme: 'nord' });
    expect(useTheme.getState().id).toBe('nord');
  });

  it('does not bump the theme version for unrelated settings changes', () => {
    settle({});
    unbind = bindThemeToSettings();
    const v = useTheme.getState().version;
    settle({ editorFontSize: 14 });
    settle({ graphColorOverrides: { light: ['#123456'] } });
    expect(useTheme.getState().version).toBe(v);
    settle({ graphColorOverrides: { 'default-dark': ['#123456'] } });
    expect(useTheme.getState().version).toBe(v + 1);
    expect(useTheme.getState().colors.graph[0]).toBe('#123456');
  });

  it('falls back to Default Dark for an unknown id', () => {
    settle({ theme: 'no-such-theme' });
    unbind = bindThemeToSettings();
    expect(useTheme.getState().id).toBe('default-dark');
  });

  it('lets a ?theme= URL parameter override the saved theme without saving it', () => {
    history.replaceState(null, '', '/?theme=solarized-light');
    settle({ theme: 'nord' });
    unbind = bindThemeToSettings();
    expect(useTheme.getState().id).toBe('solarized-light');
    expect(useAppState.getState().settings.theme).toBe('nord');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('paints the mirrored theme before the settings load, and keeps it while they load (R3: no dark flash)', () => {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ id: 'light', graph: ['#123456'] }));
    unbind = bindThemeToSettings();
    // Not loaded yet: DEFAULT_SETTINGS (Default Dark) must not be applied over the mirror.
    expect(useTheme.getState().id).toBe('light');
    expect(useTheme.getState().colors.graph[0]).toBe('#123456');
    const v = useTheme.getState().version;
    settle({ theme: 'light', graphColorOverrides: { light: ['#123456'] } });
    expect(useTheme.getState().version).toBe(v);
  });

  it('mirrors the saved theme and its lane overrides for the next start', () => {
    unbind = bindThemeToSettings();
    settle({ theme: 'nord', graphColorOverrides: { nord: [null, '#abcdef'], light: ['#000000'] } });
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toEqual({ id: 'nord', kind: 'dark', bg: '#2e3440', graph: [null, '#abcdef'] });
    settle({ theme: 'default-dark', graphColorOverrides: {} });
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toEqual({ id: 'default-dark', kind: 'dark', bg: '#1c1e23' });
  });
});
