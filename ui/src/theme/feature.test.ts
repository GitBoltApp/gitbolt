import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ api: { saveSettings: vi.fn(async () => null), saveProfile: vi.fn(async () => null) } }));

await import('./feature');
const { availableActions, hamburgerRows, runAction } = await import('../app/actions');
const { DEFAULT_SETTINGS, useAppState } = await import('../app/state');
const { useSettingsUi } = await import('../settings/schema');
const { THEME_IDS, THEMES } = await import('./themes');

describe('theme actions (R4)', () => {
  beforeEach(() => {
    useAppState.setState({ settings: DEFAULT_SETTINGS });
    useSettingsUi.setState({ open: false, focus: null, section: 'General' });
  });

  it('one palette action per theme, "Theme: <Name>", which saves that theme', () => {
    const ids = availableActions().filter((a) => a.id.startsWith('view.theme.'));
    expect(ids.map((a) => a.label)).toEqual(THEME_IDS.map((id) => `Theme: ${THEMES[id].label}`));
    expect(runAction('view.theme.solarized-dark')).toBe(true);
    expect(useAppState.getState().settings.theme).toBe('solarized-dark');
  });

  it('the menu shows only "Theme…" under View, which opens Settings on Appearance', () => {
    const view = hamburgerRows().find((r) => r.kind === 'submenu' && r.label === 'View');
    const ids = view?.kind === 'submenu' ? view.rows.map((r) => (r.kind === 'action' ? r.id : '-')) : [];
    expect(ids).toEqual(['view.theme']);
    expect(runAction('view.theme')).toBe(true);
    expect(useSettingsUi.getState()).toMatchObject({ open: true, section: 'Appearance', focus: 'theme' });
  });
});
