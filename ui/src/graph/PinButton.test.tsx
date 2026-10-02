import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { PinSetting } from '../api/gen/PinSetting';
import type { SidebarPayload } from '../api/gen/SidebarPayload';

vi.mock('../api/client', () => ({ api: { saveProfile: vi.fn(async () => null), saveSettings: vi.fn(async () => null) } }));

const { RepoContext } = await import('../app/repoContext');
const { useRuntime } = await import('../app/runtime');
const { EMPTY_PROFILE, EMPTY_REPO_SETTINGS, useAppState } = await import('../app/state');
const { PinButton } = await import('./PinButton');

const refresh = vi.fn(async () => {});
const sidebar = {
  locals: [{ name: 'main', fullName: 'refs/heads/main' }, { name: 'hotfix', fullName: 'refs/heads/hotfix' }],
  remotes: [{ name: 'origin', hostKind: 'generic', branches: [{ name: 'main', fullName: 'refs/remotes/origin/main' }] }],
} as unknown as SidebarPayload;
const setup = (pinnedRef: string | null, pin: PinSetting | null = null, compact = false) => {
  useAppState.setState({ profile: { ...EMPTY_PROFILE, repos: { '/r': { ...EMPTY_REPO_SETTINGS, pin } } } });
  useRuntime.setState({ tabs: { t1: { graph: { pinnedRef } as unknown as GraphPayload, sidebar } as never }, refresh });
  return render(<RepoContext.Provider value={{ tabId: 't1', repoId: 1, path: '/r', worktree: '/r', info: null }}><PinButton compact={compact} /></RepoContext.Provider>);
};
const stored = () => useAppState.getState().profile.repos['/r']?.pin;
const pinButton = () => screen.getByRole('button', { name: /Pinned trunk/ });

beforeEach(() => refresh.mockClear());
afterEach(() => useRuntime.setState({ tabs: {} }));

describe('PinButton (spec §8.4, amendment 4)', () => {
  it('shows the current trunk', () => {
    setup('refs/remotes/origin/main');
    expect(screen.getByRole('button', { name: 'Pinned trunk: origin/main' })).toBeInTheDocument();
  });

  it('None: the button says so', () => {
    setup(null, { kind: 'off' });
    expect(screen.getByRole('button', { name: 'Pinned trunk: No trunk' })).toBeInTheDocument();
  });

  it('compact: the icon only', () => {
    setup('refs/remotes/origin/main', null, true);
    expect(document.querySelector('.pin-name')).toBeNull();
    expect(pinButton()).toBeInTheDocument();
  });

  it('the picker offers Default (origin/HEAD), None and every branch; the current one is marked', () => {
    setup('refs/remotes/origin/main');
    fireEvent.click(pinButton());
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names[0]).toMatch(/^Default \(origin\/HEAD\)/);
    expect(names[1]).toBe('None');
    expect(names.slice(2).join('|')).toMatch(/hotfix.*main.*origin\/main/);
    expect(screen.getByRole('option', { name: /Default/ }).hasAttribute('data-current')).toBe(true);
    expect(screen.getByRole('option', { name: 'None' }).hasAttribute('data-current')).toBe(false);
  });

  it('picking a branch stores a ref pin and refreshes the graph; None and Default are reversible', () => {
    setup(null, { kind: 'off' });
    fireEvent.click(pinButton());
    expect(screen.getByRole('option', { name: 'None' }).hasAttribute('data-current')).toBe(true);
    fireEvent.click(screen.getByRole('option', { name: /^hotfix/ }));
    expect(stored()).toEqual({ kind: 'ref', name: 'refs/heads/hotfix' });
    expect(refresh).toHaveBeenLastCalledWith('t1');
    fireEvent.click(pinButton());
    fireEvent.click(screen.getByRole('option', { name: 'None' }));
    expect(stored()).toEqual({ kind: 'off' });
    fireEvent.click(pinButton());
    fireEvent.click(screen.getByRole('option', { name: /^Default/ }));
    expect(stored()).toEqual({ kind: 'auto' });
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('the picker opens under the button (K70)', () => {
    setup('refs/remotes/origin/main');
    vi.spyOn(pinButton(), 'getBoundingClientRect').mockReturnValue({ top: 20, bottom: 44, left: 10, right: 90, width: 80, height: 24, x: 10, y: 20, toJSON: () => ({}) });
    fireEvent.click(pinButton());
    expect(Number.parseFloat(document.querySelector<HTMLElement>('.picker')!.style.top)).toBeGreaterThanOrEqual(44);
  });

  it('the button toggles its picker (K42)', () => {
    setup('refs/remotes/origin/main');
    fireEvent.click(pinButton());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.pointerDown(pinButton());
    fireEvent.click(pinButton());
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
