import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ api: { saveSettings: vi.fn(async () => null), saveProfile: vi.fn(async () => null) } }));

const { AppearanceSection } = await import('./AppearanceSection');
const { DEFAULT_SETTINGS, useAppState } = await import('../app/state');
const { ContextMenu } = await import('../menu/ContextMenu');
const { useMenu } = await import('../menu/menuStore');
const { THEME_IDS, THEMES } = await import('./themes');

const settings = () => useAppState.getState().settings;
const lane = (n: number) => screen.getByLabelText(`Lane ${n} color`) as HTMLInputElement;
/** Types into a lane's box and applies it (Enter submits its form). */
function typeLane(n: number, value: string) {
  fireEvent.change(lane(n), { target: { value } });
  fireEvent.submit(lane(n).form!);
}

describe('AppearanceSection', () => {
  beforeEach(() => useAppState.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'default-dark', graphColorOverrides: {} } }));
  afterEach(() => act(() => useMenu.getState().close()));

  it('lists every theme, in menu order, in the app\'s own dropdown, and saves the chosen one', () => {
    render(<><AppearanceSection /><ContextMenu /></>);
    const button = screen.getByRole('button', { name: 'Theme' });
    expect(button).toHaveTextContent('Default Dark');
    expect(document.querySelector('select')).toBeNull();
    fireEvent.click(button);
    expect(screen.getAllByRole('menuitem').map((r) => r.textContent)).toEqual(THEME_IDS.map((id) => THEMES[id].label));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Monokai' }));
    expect(settings().theme).toBe('monokai');
    expect(screen.getByRole('button', { name: 'Theme' })).toHaveTextContent('Monokai');
  });

  it("shows an unknown saved theme as Default Dark", () => {
    useAppState.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'no-such-theme' } });
    render(<AppearanceSection />);
    expect(screen.getByRole('button', { name: 'Theme' })).toHaveTextContent('Default Dark');
  });

  it('overrides one lane color for the current theme and resets it', () => {
    useAppState.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'nord', graphColorOverrides: {} } });
    render(<AppearanceSection />);
    expect(lane(3).value).toBe(THEMES.nord.graph[2]);
    typeLane(3, '#112233');
    expect(settings().graphColorOverrides.nord).toEqual([null, null, '#112233', null, null, null, null, null, null, null]);
    expect(lane(3).value).toBe('#112233');
    fireEvent.click(screen.getByRole('button', { name: 'Reset lane colors' }));
    expect(settings().graphColorOverrides.nord).toBeUndefined();
    expect(lane(3).value).toBe(THEMES.nord.graph[2]);
  });

  it('takes a colour without its #, in any case, expands #rgb, and snaps an invalid one back', () => {
    useAppState.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'light', graphColorOverrides: { nord: ['#000000'] } } });
    render(<AppearanceSection />);
    typeLane(1, 'ABCDEF');
    expect(settings().graphColorOverrides.light?.[0]).toBe('#abcdef');
    typeLane(3, '#F0a');
    expect(settings().graphColorOverrides.light?.[2]).toBe('#ff00aa');
    expect(lane(3).value).toBe('#ff00aa');
    typeLane(2, 'blue-ish');
    expect(lane(2).value).toBe(THEMES.light.graph[1]);
    expect(settings().graphColorOverrides.light?.[1]).toBeNull();
    // Another theme's override is left alone.
    expect(settings().graphColorOverrides.nord).toEqual(['#000000']);
  });

  it("clearing a lane's box goes back to the theme's colour, and the last one drops the theme's entry", () => {
    useAppState.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'nord', graphColorOverrides: { nord: [null, '#123456'] } } });
    render(<AppearanceSection />);
    expect(screen.getByRole('button', { name: 'Reset lane colors' })).toBeEnabled();
    typeLane(2, '');
    expect(settings().graphColorOverrides.nord).toBeUndefined();
    expect(lane(2).value).toBe(THEMES.nord.graph[1]);
    expect(screen.getByRole('button', { name: 'Reset lane colors' })).toBeDisabled();
  });
});
