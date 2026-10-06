import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { createRepoViewStore, RepoViewContext, targetFor } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { DEFAULT_DIFF_PREFS, useDiffPrefs } from './diffPrefs';

const host = vi.hoisted(() => ({ goToChange: vi.fn() }));
vi.mock('./monaco/load', () => ({ loadMonacoHost: async () => host }));
const { DiffToolbar, goToChange, RENDERED_MODE_TIP, RENDERED_WHITESPACE_TIP, RENDERED_WRAP_TIP } = await import('./DiffToolbar');
const { setChangeStepper } = await import('./changeStepper');

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const target = targetFor({ path: 'guide.md', oldPath: null, status: 'M', additions: 1, deletions: 1, old: { kind: 'object', oid: 'a'.repeat(40) }, new: { kind: 'object', oid: 'b'.repeat(40) }, submodule: false }, { kind: 'commit', id: 'c'.repeat(40), parent: 0 });
const button = (name: string) => screen.getByRole('button', { name });
const bar = (rendered: boolean) => render(<RepoViewContext value={createRepoViewStore(1, '/r', graph, fakeServices())}><DiffToolbar target={target} canDiff canStep textTools rendered={rendered} /></RepoViewContext>);

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); useDiffPrefs.setState({ prefs: DEFAULT_DIFF_PREFS }); });

describe('the diff toolbar while the rendered Markdown diff shows (5C, R3)', () => {
  it('keeps the view mode, whitespace and wrap in place, off, each saying why', () => {
    bar(true);
    for (const name of ['Hunk', 'Inline', 'Split']) expect(button(name)).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button('Split'));
    fireEvent.mouseEnter(button('Split'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(RENDERED_MODE_TIP);
    fireEvent.mouseLeave(button('Split'));
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
