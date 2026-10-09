import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { createRepoViewStore, RepoViewContext, targetFor } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { DEFAULT_DIFF_PREFS, DIFF_PREFS_STORAGE_KEY, useDiffPrefs } from './diffPrefs';

const host = vi.hoisted(() => ({ goToChange: vi.fn() }));
vi.mock('./monaco/load', () => ({ loadMonacoHost: async () => host }));
const { DiffToolbar, goToChange, RENDERED_HUNK_TIP, RENDERED_WHITESPACE_TIP, RENDERED_WRAP_TIP } = await import('./DiffToolbar');
const { setChangeStepper } = await import('./changeStepper');

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const target = targetFor({ path: 'guide.md', oldPath: null, status: 'M', additions: 1, deletions: 1, old: { kind: 'object', oid: 'a'.repeat(40) }, new: { kind: 'object', oid: 'b'.repeat(40) }, submodule: false }, { kind: 'commit', id: 'c'.repeat(40), parent: 0 });
const button = (name: string) => screen.getByRole('button', { name });
const bar = (rendered: boolean) => render(<RepoViewContext value={createRepoViewStore(1, '/r', graph, fakeServices())}><DiffToolbar target={target} canDiff canStep textTools rendered={rendered} /></RepoViewContext>);

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); useDiffPrefs.setState({ prefs: DEFAULT_DIFF_PREFS }); });

describe('the diff toolbar while the rendered Markdown diff shows (5C, R3)', () => {
  it('keeps Hunk, whitespace and wrap in place, off, each saying why', () => {
    bar(true);
    expect(button('Hunk')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button('Hunk'));
    fireEvent.mouseEnter(button('Hunk'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(RENDERED_HUNK_TIP);
    fireEvent.mouseLeave(button('Hunk'));
    for (const [name, tip] of [['Ignore whitespace', RENDERED_WHITESPACE_TIP], ['Word wrap', RENDERED_WRAP_TIP]] as const) {
      expect(button(name)).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(button(name));
      fireEvent.mouseEnter(button(name));
      expect(screen.getByRole('tooltip')).toHaveTextContent(tip);
      fireEvent.mouseLeave(button(name));
    }
    expect(useDiffPrefs.getState().prefs).toEqual(DEFAULT_DIFF_PREFS);
    expect(button('Next change')).toBeEnabled();
  });

  it('Inline and Split pick the rendered layout: the saved diff mode, so it persists', () => {
    bar(true);
    for (const name of ['Inline', 'Split']) expect(button(name)).not.toHaveAttribute('aria-disabled');
    expect(button('Inline')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button('Split'));
    expect(useDiffPrefs.getState().prefs.mode).toBe('split');
    expect(button('Split')).toHaveAttribute('aria-pressed', 'true');
    expect(JSON.parse(localStorage.getItem(DIFF_PREFS_STORAGE_KEY)!).mode).toBe('split');
    fireEvent.click(button('Inline'));
    expect(useDiffPrefs.getState().prefs.mode).toBe('inline');
  });

  it('a saved Hunk shows the rendered diff as Inline, leaving the pick as it is', () => {
    useDiffPrefs.setState({ prefs: { ...DEFAULT_DIFF_PREFS, mode: 'hunk' } });
    bar(true);
    expect(button('Inline')).toHaveAttribute('aria-pressed', 'true');
    expect(button('Hunk')).toHaveAttribute('aria-pressed', 'false');
    expect(useDiffPrefs.getState().prefs.mode).toBe('hunk');
  });

  it('in Source they work as before', () => {
    bar(false);
    expect(button('Split')).not.toHaveAttribute('aria-disabled');
    fireEvent.click(button('Split'));
    expect(useDiffPrefs.getState().prefs.mode).toBe('split');
  });

  it("Previous/Next change use the rendered diff's stepper while one is set, else the editor", async () => {
    const step = vi.fn();
    const off = setChangeStepper(step);
    goToChange('next');
    expect(step).toHaveBeenCalledWith('next');
    off();
    goToChange('previous');
    await vi.waitFor(() => expect(host.goToChange).toHaveBeenCalledWith('previous'));
    expect(step).toHaveBeenCalledTimes(1);
  });
});
