import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalBranch } from '../api/gen/LocalBranch';
import type { RefLabel } from '../api/gen/RefLabel';
import { RefLabels } from '../graph/RefLabels';
import { ItemIcon } from '../sidebar/SidebarPanel';
import type { SideItem } from '../sidebar/model';
import { endPending, startPending, usePending, withPending } from './store';

const TAB = '';
const REF = 'refs/heads/feature';

afterEach(() => { cleanup(); usePending.setState({ byTab: {} }); });

describe('pending store', () => {
  it('sets while the action runs and clears when it succeeds', async () => {
    let release!: () => void;
    const p = withPending('t1', [REF], 'checkout', () => new Promise<void>((r) => { release = r; }));
    expect(usePending.getState().byTab.t1[REF]).toBe('checkout');
    release();
    await p;
    expect(usePending.getState().byTab.t1[REF]).toBeUndefined();
  });

  it('clears on failure too', async () => {
    await expect(withPending('t1', [REF], 'push', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(usePending.getState().byTab.t1[REF]).toBeUndefined();
  });

  it('a later action on the same ref is not cleared by the earlier one ending', () => {
    startPending('t1', REF, 'push');
    startPending('t1', REF, 'delete');
    endPending('t1', REF, 'push');
    expect(usePending.getState().byTab.t1[REF]).toBe('delete');
  });
});

const chip = (over: Partial<RefLabel> = {}): RefLabel => ({ row: 0, name: 'feature', local: REF, tag: false, isHead: false, worktree: null, checkedOut: null, remotes: [], ...over });

describe('the graph chip', () => {
  it('HEAD chip: the spinner takes the checkmark box, the checkmark returns after', () => {
    const { container } = render(<RefLabels labels={[chip({ isHead: true })]} color={0} />);
    const check = container.querySelector('svg.ref-head-check');
    expect(check).toBeTruthy();
    act(() => startPending(TAB, REF, 'push'));
    expect(container.querySelector('.pending-mark')).toHaveClass('ref-head-check');
    act(() => endPending(TAB, REF));
    expect(container.querySelector('svg.ref-head-check')).toBeTruthy();
  });

  it("non-HEAD chip, checkout: the spinner sits where the checkmark will appear, and the local icon stays", () => {
    const { container } = render(<RefLabels labels={[chip()]} color={0} />);
    act(() => startPending(TAB, REF, 'checkout'));
    const mark = container.querySelector('.pending-mark.ref-head-check');
    expect(mark).toBeTruthy();
    // On the left: before the branch name.
    const name = container.querySelector('.ref-name, .ref-name-full')!;
    expect(mark!.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('svg[aria-label="local"]')).toBeTruthy();
    act(() => endPending(TAB, REF));
    expect(container.querySelector('.pending-mark')).toBeNull();
  });

  it('non-HEAD chip, another action (push): the spinner replaces the source icon; same children count and slot class', () => {
    const { container } = render(<RefLabels labels={[chip()]} color={0} />);
    const slots = () => [...container.querySelectorAll('.ref-label > *')];
    const before = slots();
    const slotClass = before.at(-1)!.className;
    act(() => startPending(TAB, REF, 'push'));
    const during = slots();
    expect(during).toHaveLength(before.length);
    expect(during.at(-1)!.className).toBe(slotClass);
    expect(container.querySelector('.pending-mark')).toBeTruthy();
    expect(container.querySelector('svg[aria-label="local"]')).toBeNull();
    expect(container.querySelector('.ref-head-check')).toBeNull();
    act(() => endPending(TAB, REF));
    expect(container.querySelector('svg[aria-label="local"]')).toBeTruthy();
  });

  it('a remote chip spins its remote icon (not a checkout)', () => {
    const remote = chip({ local: null, remotes: [{ fullName: 'refs/remotes/origin/feature', remote: 'origin', host: null, hostKind: 'generic' }] });
    const { container } = render(<RefLabels labels={[remote]} color={0} />);
    act(() => startPending(TAB, 'refs/remotes/origin/feature', 'push'));
    expect(container.querySelector('.pending-mark')).toBeTruthy();
  });
});

const local = (isHead: boolean): SideItem => ({
  kind: 'local', name: 'feature', target: 'a'.repeat(40), time: 0, branch: { name: 'feature', fullName: REF, isHead } as LocalBranch,
} as unknown as SideItem);

describe('the sidebar row', () => {
  it('shows the spinner in the icon box while pending, then the icon or the check', () => {
    const { container, rerender } = render(<ItemIcon item={local(false)} tabId={TAB} />);
    expect(container.querySelector('svg')).toBeTruthy();
    act(() => startPending(TAB, REF, 'checkout'));
    expect(container.querySelector('.pending-mark')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
    act(() => endPending(TAB, REF));
    rerender(<ItemIcon item={local(true)} tabId={TAB} />);
    expect(container.querySelector('.co-check')).toBeTruthy();
    expect(container.querySelector('.pending-mark')).toBeNull();
  });

  it('no layout shift: the mark is one element in the one slot, sized by the stylesheet', () => {
    const { container } = render(<ItemIcon item={local(false)} tabId={TAB} />);
    act(() => startPending(TAB, REF, 'checkout'));
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toHaveClass('pending-mark');
  });
});
