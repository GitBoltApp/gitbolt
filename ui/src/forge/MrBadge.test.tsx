import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefLabel } from '../api/gen/RefLabel';

const poll = vi.hoisted(() => ({ openMrView: vi.fn(), loadMrDetail: vi.fn(async () => {}) }));
vi.mock('./poll', () => poll);

const { RefLabels } = await import('../graph/RefLabels');
const { RepoContext } = await import('../app/repoContext');
const { patchForge, useForge } = await import('./mrStore');
const { mrOf } = await import('./testMrs');

const ctx = { tabId: 't', repoId: 4, path: '/r', worktree: '/r', info: null };
const origin = { fullName: 'refs/remotes/origin/dev', remote: 'origin', host: 'gitlab.example.com', hostKind: 'gitlab' as const };
const dev: RefLabel = { row: 0, name: 'dev', local: 'refs/heads/dev', tag: false, isHead: false, worktree: null, checkedOut: null, remotes: [origin] };
const show = (label: RefLabel) => render(<RepoContext value={ctx}><div data-testid="row" onMouseDown={rowDown}><RefLabels labels={[label]} color={0} /></div></RepoContext>);
const icons = (c: HTMLElement) => c.querySelectorAll('.ref-labels > .ref-label > .ref-icon').length;
const rowDown = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
});

describe('the MR/PR badge on a branch chip (spec #4 §2 "Badge", §5)', () => {
  it("is its own icon after the local and remote ones, which stay (where the branch is still reads)", () => {
    const { container } = show(dev);
    expect(icons(container)).toBe(2);
    expect(screen.queryByRole('button', { name: /Merge request/ })).toBeNull();
    act(() => patchForge('t', { kind: 'gitlab', byRef: { 'refs/remotes/origin/dev': mrOf(12) } }));
    expect(screen.getByRole('button', { name: 'Merge request !12: open' })).toBeTruthy();
    expect(icons(container)).toBe(3);
    expect(container.querySelector('[aria-label="local"]')).toBeTruthy();
  });

  it("a local branch whose upstream has the MR keeps its local icon, the badge beside it", () => {
    const local: RefLabel = { ...dev, remotes: [] };
    patchForge('t', { kind: 'gitlab', byRef: { 'refs/remotes/origin/dev': mrOf(9, { state: 'merged' }) }, upstreams: { 'refs/heads/dev': 'refs/remotes/origin/dev' } });
    const { container } = show(local);
    expect(screen.getByRole('button', { name: 'Merge request !9: merged' })).toBeTruthy();
    expect(icons(container)).toBe(2);
    expect(container.querySelector('[aria-label="local"]')).toBeTruthy();
  });

  it('a click opens the MR/PR view and neither selects the row nor checks out', () => {
    patchForge('t', { kind: 'github', byRef: { 'refs/remotes/origin/dev': mrOf(3, { state: 'draft' }) } });
    show(dev);
    const badge = screen.getByRole('button', { name: 'Pull request #3: draft' });
    fireEvent.mouseDown(badge);
    fireEvent.click(badge);
    fireEvent.doubleClick(badge);
    expect(poll.openMrView).toHaveBeenCalledWith('t', 3);
    expect(rowDown).not.toHaveBeenCalled();
  });

  it('its hover card shows the MR/PR and loads its detail', async () => {
    patchForge('t', { kind: 'gitlab', byRef: { 'refs/remotes/origin/dev': mrOf(12, { title: 'Dev work' }) } });
    show(dev);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Merge request !12: open' }));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('!12 Dev work');
    expect(tip).toHaveTextContent('Click to open');
    await waitFor(() => expect(poll.loadMrDetail).toHaveBeenCalledWith('t', 12));
  });

  it('shows nothing without a forge for the repo', () => {
    patchForge('t', { kind: null, byRef: { 'refs/remotes/origin/dev': mrOf(12) } });
    show(dev);
    expect(screen.queryByRole('button', { name: /Merge request/ })).toBeNull();
  });
});
