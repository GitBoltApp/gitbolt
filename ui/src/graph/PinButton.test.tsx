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
  locals: [
    { name: 'main', fullName: 'refs/heads/main', upstream: 'refs/remotes/origin/main', gone: false },
    { name: 'hotfix', fullName: 'refs/heads/hotfix', upstream: null, gone: false },
    { name: 'trunk', fullName: 'refs/heads/trunk', upstream: 'refs/remotes/origin/main', gone: false },
  ],
  remotes: [{ name: 'origin', hostKind: 'generic', branches: [{ name: 'main', fullName: 'refs/remotes/origin/main' }, { name: 'topic', fullName: 'refs/remotes/origin/topic' }] }],
} as unknown as SidebarPayload;
const PAIR = ['refs/heads/main', 'refs/remotes/origin/main'];
const setup = (pinnedRefs: string[], pin: PinSetting | null = null, compact = false) => {
  useAppState.setState({ profile: { ...EMPTY_PROFILE, repos: { '/r': { ...EMPTY_REPO_SETTINGS, pin } } } });
  useRuntime.setState({ tabs: { t1: { graph: { pinnedRefs } as unknown as GraphPayload, sidebar } as never }, refresh });
  return render(<RepoContext.Provider value={{ tabId: 't1', repoId: 1, path: '/r', worktree: '/r', info: null }}><PinButton compact={compact} /></RepoContext.Provider>);
};
const stored = () => useAppState.getState().profile.repos['/r']?.pin;
const pinButton = () => screen.getByRole('button', { name: /Pinned trunk/ });

beforeEach(() => refresh.mockClear());
afterEach(() => useRuntime.setState({ tabs: {} }));

describe('PinButton (spec §8.4, amendment 4)', () => {
  it('shows the current trunk: the pinned pair, local first, or the one branch pinned alone', () => {
    setup(PAIR);
    expect(screen.getByRole('button', { name: 'Pinned trunk: main ↔ origin/main' })).toBeInTheDocument();
    fireEvent.mouseEnter(pinButton());
    expect(screen.getByRole('tooltip').textContent).toBe('Pinned trunk: main ↔ origin/main (default): both main and origin/main stay at the left. Click to change');
  });

  it('a branch pinned alone shows its name only', () => {
    setup(['refs/remotes/origin/topic'], { kind: 'ref', name: 'refs/remotes/origin/topic' });
    expect(screen.getByRole('button', { name: 'Pinned trunk: origin/topic' })).toBeInTheDocument();
    fireEvent.mouseEnter(pinButton());
    expect(screen.getByRole('tooltip').textContent).toBe('Pinned trunk: origin/topic. Click to change');
  });

  it('None: the button says so', () => {
    setup([], { kind: 'off' });
    expect(screen.getByRole('button', { name: 'Pinned trunk: No trunk' })).toBeInTheDocument();
  });

  it('compact: the icon only', () => {
    setup(PAIR, null, true);
    expect(document.querySelector('.pin-name')).toBeNull();
    expect(pinButton()).toBeInTheDocument();
  });

  it('the picker offers Default, None and every branch; the current one is marked', () => {
    setup(PAIR);
    fireEvent.click(pinButton());
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names[0]).toBe('Defaultmain ↔ origin/main');
    expect(names[1]).toBe('None');
    expect(names.slice(2).join('|')).toMatch(/hotfix.*main.*origin\/main/);
    expect(screen.getByRole('option', { name: /Default/ }).hasAttribute('data-current')).toBe(true);
    expect(screen.getByRole('option', { name: 'None' }).hasAttribute('data-current')).toBe(false);
    fireEvent.mouseEnter(screen.getByRole('option', { name: /Default/ }));
    expect(screen.getByRole('tooltip').textContent).toBe('The local branch that tracks the main remote\'s default branch (its HEAD), pinned with that remote branch: both stay at the left. The remote branch alone if no local branch tracks it. The main remote is the one the others are forks of, else upstream, else origin. With no remote: main, master, dev or develop');
  });

  it('each branch\'s tooltip names the pair it pins, as the core pairs it', () => {
    setup(PAIR);
    fireEvent.click(pinButton());
    const tip = (name: RegExp) => {
      const option = screen.getByRole('option', { name });
      fireEvent.mouseEnter(option);
      const text = screen.getByRole('tooltip').textContent;
      fireEvent.mouseLeave(option);
      return text;
    };
    expect(tip(/^mainlocal/)).toBe('Pin main ↔ origin/main: both stay at the left');
    expect(tip(/^hotfix/)).toBe('Pin hotfix as the trunk');
    // Two local branches track origin/main: the one named like it pairs.
    expect(tip(/^origin\/main/)).toBe('Pin main ↔ origin/main: both stay at the left');
    expect(tip(/^origin\/topic/)).toBe('Pin origin/topic as the trunk');
  });

  it('picking a branch stores a ref pin and refreshes the graph; None and Default are reversible', () => {
    setup([], { kind: 'off' });
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
    setup(PAIR);
    vi.spyOn(pinButton(), 'getBoundingClientRect').mockReturnValue({ top: 20, bottom: 44, left: 10, right: 90, width: 80, height: 24, x: 10, y: 20, toJSON: () => ({}) });
    fireEvent.click(pinButton());
    expect(Number.parseFloat(document.querySelector<HTMLElement>('.picker')!.style.top)).toBeGreaterThanOrEqual(44);
  });

  it('the button toggles its picker (K42)', () => {
    setup(PAIR);
    fireEvent.click(pinButton());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.pointerDown(pinButton());
    fireEvent.click(pinButton());
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
