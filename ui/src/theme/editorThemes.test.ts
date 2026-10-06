import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { editorColors } from '../diff/monaco/theme';
import exceptions from '../../build/license-exceptions.json';
import { bindEditorTheme, currentEditorTheme, editorThemeRegistrations, SHIKI_THEMES } from './editorThemes';
import { useTheme } from './store';
import { SHIKI_BUNDLED_THEMES, THEME_IDS, THEMES } from './themes';

describe('editor themes', () => {
  it("bundles only the Shiki themes GitBolt uses, never Shiki's whole registry or a dropped theme", () => {
    expect(Object.keys(SHIKI_THEMES).sort()).toEqual([...SHIKI_BUNDLED_THEMES].sort());
    const dropped = Object.keys(exceptions.dropped.themes);
    expect(dropped).toContain('aurora-x');
    for (const id of dropped) expect(Object.keys(SHIKI_THEMES)).not.toContain(id);
    const src = readFileSync(join(process.cwd(), 'src/theme/editorThemes.ts'), 'utf8');
    expect(src).not.toMatch(/from 'shiki\/themes'/);
  });

  it('registers a theme for every ThemeDef, named as it names it, each with its own overlay', async () => {
    const regs = await Promise.all(editorThemeRegistrations());
    expect(regs.map((r) => r.name)).toEqual(THEME_IDS.map((id) => THEMES[id].editorTheme));
    expect(new Set(regs.map((r) => r.name)).size).toBe(THEME_IDS.length);
    regs.forEach((r, i) => {
      const def = THEMES[THEME_IDS[i]];
      expect(r.colors).toMatchObject(editorColors(def));
      expect(r.colors?.['editor.background']).toBe(def.colors['app-bg0'].toLowerCase());
    });
  });

  it('derives the overlay from the theme tokens, and Default Dark keeps its tuned values', () => {
    const d = editorColors(THEMES['default-dark']);
    expect(d['editor.background']).toBe('#1c1e23');
    expect(d['scrollbarSlider.background']).toBe('#ffffff26');
    expect(d['scrollbarSlider.hoverBackground']).toBe('#ffffff40');
    expect(d['diffEditor.removedTextBackground']).toBe('#d9413d33');
    expect(editorColors(THEMES.darcula)['editor.background']).toBe(THEMES.darcula.colors['app-bg0'].toLowerCase());
    expect(editorColors(THEMES.light)['editor.selectionBackground']).toBe(THEMES.light.colors['selection-bg'].toLowerCase());
  });

  it('pushes the editor theme on bind and on every app theme change, once per change', () => {
    act(() => useTheme.getState().set('default-dark', {}));
    const setTheme = vi.fn();
    const unbind = bindEditorTheme(setTheme);
    expect(setTheme).toHaveBeenLastCalledWith('dark-plus');
    act(() => useTheme.getState().set('darcula', {}));
    expect(setTheme).toHaveBeenLastCalledWith('darcula');
    act(() => useTheme.getState().set('darcula', { darcula: ['#123456'] }));
    expect(setTheme).toHaveBeenCalledTimes(2);
    expect(currentEditorTheme()).toBe('darcula');
    unbind();
  });
});
