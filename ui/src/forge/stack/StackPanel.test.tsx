import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { LocalBranch } from '../../api/gen/LocalBranch';
import { useRuntime } from '../../app/runtime';
import { MrCardLive } from '../MrCardLive';
import { StackLine } from './StackLine';
import { StackPanel } from './StackPanel';

const mrs: Record<string, ForgeMr> = {};
const openMrView = vi.fn();
const run = vi.fn();
const project = { kind: 'gitlab' as const, id: 42, host: 'gitlab.example.com', path: 'group/project', name: 'project', owner: 'group', webUrl: '', defaultBranch: 'main', cloneHttps: '', cloneSsh: '', forkOf: null, updatedAt: null, archived: false };
vi.mock('./deps', () => ({
  forgeTarget: () => ({ remote: 'origin', kind: 'gitlab', project }),
  branchMr: (_t: string, b: string) => mrs[b] ?? null,
  branchMrs: () => (b: string) => mrs[b] ?? null,
  useTabForge: () => ({}),
  useTabForgeField: () => null,
  openMrView: (...a: unknown[]) => openMrView(...a),
}));
vi.mock('./retarget', async (orig) => ({ ...(await orig<typeof import('./retarget')>()), retargetAndRebase: (...a: unknown[]) => run(...a) }));

const stk = vi.hoisted(() => ({ s: null as unknown }));
vi.mock('../../stacks/detect', async (orig) => {
  const real = await orig<typeof import('../../stacks/detect')>();
  return { ...real, stackFor: (...a: Parameters<typeof real.stackFor>) => (stk.s as never) ?? real.stackFor(...a) };
});

vi.mock('../useMrDetail', () => ({ useMrDetail: () => ({ detail: null, error: null }) }));

const mr = (number: number, source: string, target: string, state: ForgeMr['state'] = 'open'): ForgeMr => ({
  number, title: `MR ${number}`, state, author: { id: 1, username: 'ada', name: 'Ada', avatarUrl: null, webUrl: '', email: null },
  sourceProject: 'group/project', sourceBranch: source, targetProject: 'group/project', targetBranch: target, headSha: `head${number}`,
  webUrl: '', pipeline: null, review: { decision: 'none', approvals: 0, approvalsRequired: null, reviews: [] }, conflicts: false, labels: [], labelColors: {}, updatedAt: number, autoMerge: null, stacked: true,
});
const lb = (name: string): LocalBranch => ({
  name, fullName: `refs/heads/${name}`, target: `${name}-tip`, upstream: null, ahead: 0, behind: 0, gone: false, tipTime: 0, summary: '', author: '',
  isHead: false, worktree: null, checkedOut: null, pushTarget: null, pushBehind: null, rewritten: null,
});
const tab = (head: string, inProgress: string | null = null) => useRuntime.getState().patch('t', {
  repo: { id: 1, path: '/r' }, worktree: '/r',
  graph: { rows: [], labels: [], worktrees: [{ path: '/r', isMain: true, inProgress }], head: { branch: `refs/heads/${head}`, target: null, detached: false, unborn: false } },
  sidebar: { locals: [lb('feature/a'), lb('feature/b'), lb('feature/c')], remotes: [], worktrees: [], stashes: [], tags: [] },
} as never);

describe('the stack in the hover card and the MR/PR view (spec #4 §4 4D)', () => {
  beforeEach(() => {
    openMrView.mockReset();
    stk.s = null;
    run.mockReset();
    for (const k of Object.keys(mrs)) delete mrs[k];
    mrs['feature/a'] = mr(1, 'feature/a', 'main', 'merged');
    mrs['feature/b'] = mr(2, 'feature/b', 'feature/a');
    mrs['feature/c'] = mr(3, 'feature/c', 'feature/b', 'draft');
  });

  it('the hover card says the position and the neighbours; an MR that is not stacked shows nothing', () => {
    tab('feature/b');
    const { container, rerender } = render(<StackLine tabId="t" mr={mrs['feature/b']} />);
    expect(container).toHaveTextContent('Stack 2 of 3 (below: !1, above: !3)');
    rerender(<StackLine tabId="t" mr={mr(9, 'solo', 'main')} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the view lists the stack bottom first, marks this one, and opens the others', () => {
    tab('feature/b');
    render(<StackPanel tabId="t" mr={mrs['feature/b']} />);
    const section = screen.getByRole('region', { name: 'Stack' });
    const items = section.querySelectorAll('li');
    expect([...items].map((li) => li.textContent)).toEqual(['!1 MR 1Merged', '!2 MR 2Open', '!3 MR 3Draft']);
    expect(items[1]).toHaveAttribute('aria-current', 'true');
    fireEvent.click(screen.getByRole('button', { name: '!3 MR 3' }));
    expect(openMrView).toHaveBeenCalledWith('t', 3);
  });

  it('after the bottom merged it offers the one-click retarget and rebase, greyed until the top is checked out', () => {
    tab('feature/b');
    const { unmount } = render(<StackPanel tabId="t" mr={mrs['feature/b']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retarget !2 and rebase the stack' }));
    expect(run.mock.calls[0][1]).toMatchObject({ merged: { number: 1 }, next: { number: 2 }, retarget: true });
    unmount();
    tab('feature/a');
    render(<StackPanel tabId="t" mr={mrs['feature/b']} />);
    expect(screen.getByRole('button', { name: 'Retarget !2 and rebase the stack' })).toBeDisabled();
    expect(screen.getByText('Check out feature/b first')).toBeInTheDocument();
  });

  it('greyed while an operation is in progress, as the menu row and the prompt are', () => {
    tab('feature/b', 'rebase');
    render(<StackPanel tabId="t" mr={mrs['feature/b']} />);
    expect(screen.getByRole('button', { name: 'Retarget !2 and rebase the stack' })).toBeDisabled();
    expect(screen.getByText('Finish or abort the rebase first')).toBeInTheDocument();
  });

  it('a native GitLab stack (no tables): the chain shows; after GitLab retargets, the panel offers the rebase-only path', () => {
    for (const k of Object.keys(mrs)) delete mrs[k];
    mrs['feature/a'] = { ...mr(1, 'feature/a', 'main'), stacked: false };
    mrs['feature/b'] = { ...mr(2, 'feature/b', 'feature/a'), stacked: false };
    tab('feature/b');
    const { unmount } = render(<StackPanel tabId="t" mr={mrs['feature/b']} />);
    expect([...screen.getByRole('region', { name: 'Stack' }).querySelectorAll('li')].map((li) => li.textContent)).toEqual(['!1 MR 1Open', '!2 MR 2Open']);
    unmount();
    mrs['feature/a'] = { ...mr(1, 'feature/a', 'main', 'merged'), stacked: false };
    mrs['feature/b'] = { ...mr(2, 'feature/b', 'main'), stacked: false };
    stk.s = { branches: ['feature/a', 'feature/b'], base: 'refs/remotes/origin/main', leftBehind: [] };
    render(<StackPanel tabId="t" mr={mrs['feature/b']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rebase the stack without the merged !1' }));
    expect(run.mock.calls[0][1]).toMatchObject({ merged: { number: 1 }, retarget: false, branches: ['feature/b'] });
  });

  it('a closed member says Closed', () => {
    tab('feature/b');
    mrs['feature/a'] = mr(1, 'feature/a', 'main', 'closed');
    render(<StackPanel tabId="t" mr={mrs['feature/b']} />);
    expect(screen.getByRole('region', { name: 'Stack' }).querySelectorAll('li')[0]).toHaveTextContent('Closed');
  });

  it('the current MR at the bottom and at the top', () => {
    tab('feature/a');
    const { container, unmount } = render(<StackLine tabId="t" mr={mrs['feature/a']} />);
    expect(container).toHaveTextContent('Stack 1 of 3 (above: !2)');
    unmount();
    const r = render(<StackLine tabId="t" mr={mrs['feature/c']} />);
    expect(r.container).toHaveTextContent('Stack 3 of 3 (below: !2)');
  });

  it('the hover card shows the stack line before the detail loads, inside the card', () => {
    tab('feature/b');
    render(<MrCardLive tabId="t" kind="gitlab" mr={mrs['feature/b']} hint="Click to open" />);
    const card = screen.getByRole('group');
    expect(card).toHaveTextContent('Stack 2 of 3');
    expect(card.querySelector('.mr-stack-line')?.nextElementSibling).toHaveClass('mr-card-hint');
  });
});
