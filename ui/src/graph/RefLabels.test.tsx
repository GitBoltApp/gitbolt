import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RemoteRefLabel } from '../api/gen/RemoteRefLabel';
import { chipRefs } from './membership';
import { RefLabels } from './RefLabels';
import { useTheme } from '../theme/store';
import { THEMES } from '../theme/themes';

const remote = (name: string, branch: string): RemoteRefLabel => ({ fullName: `refs/remotes/${name}/${branch}`, remote: name, host: null, hostKind: 'generic' });

const remoteOnly = (branch: string, ...remotes: string[]): RefLabel => ({
  row: 0, name: branch, local: null, tag: false, isHead: false, worktree: null, checkedOut: null,
  remotes: remotes.map((r) => remote(r, branch)),
});

const LONG = 'feature/a-very-long-branch-name-that-the-chip-truncates';

describe('RefLabels', () => {
  it('draws the rebased branch with a spinner at HEAD, even with no label of its own (2D T18)', () => {
    const { rerender } = render(<RefLabels labels={[]} color={0} rebasing="main" />);
    expect(screen.getByLabelText('main (rebasing)')).toHaveClass('ref-rebasing');
    const other = remoteOnly('topic', 'origin');
    rerender(<RefLabels labels={[other]} color={0} rebasing="main" />);
    expect(screen.getByLabelText('main (rebasing)')).toBeInTheDocument();
    rerender(<RefLabels labels={[other]} color={0} />);
    expect(screen.queryByLabelText('main (rebasing)')).toBeNull();
  });

  it('the rebasing chip expands on hover to its full name like the other chips, with its tooltip (UX round 2)', () => {
    render(<RefLabels labels={[]} color={0} rebasing={LONG} width={60} />);
    const chip = screen.getByLabelText(`${LONG} (rebasing)`);
    expect(chip.querySelector('.ref-label-full')).toBeNull();
    fireEvent.mouseEnter(chip);
    expect(chip.querySelector('.ref-label-full .ref-name-full')).toHaveTextContent(LONG);
    expect(screen.getByRole('tooltip')).toHaveTextContent(`${LONG} is being rebased`);
    fireEvent.mouseLeave(chip);
    expect(chip.querySelector('.ref-label-full')).toBeNull();
  });

  it('a detached HEAD beside other chips is icon-only, named by its tooltip, and expands to "HEAD" on hover (UX round 2)', () => {
    const detached: RefLabel = { row: 0, name: 'HEAD', local: null, tag: false, isHead: true, worktree: null, checkedOut: null, remotes: [] };
    const main: RefLabel = { row: 0, name: 'main', local: 'refs/heads/main', tag: false, isHead: false, worktree: null, checkedOut: null, remotes: [] };
    const { container, rerender } = render(<RefLabels labels={[detached, main]} color={0} rebasing="feature/x" width={300} sha={'c'.repeat(40)} />);
    const head = container.querySelector<HTMLElement>('.ref-labels > .ref-label-head:not(.ref-rebasing)')!;
    expect(head).toHaveClass('compact');
    expect(head.querySelector('.ref-name')).toBeNull();
    fireEvent.mouseEnter(head);
    expect(screen.getByRole('tooltip')).toHaveTextContent('HEAD (detached at ccccccc)');
    expect(head.querySelector('.ref-label-full')).toHaveTextContent('HEAD');
    fireEvent.mouseLeave(head);
    // Alone in its cell, it keeps its name.
    rerender(<RefLabels labels={[detached]} color={0} width={300} sha={'c'.repeat(40)} />);
    const alone = container.querySelector<HTMLElement>('.ref-labels > .ref-label-head')!;
    expect(alone).not.toHaveClass('compact');
    expect(alone).toHaveTextContent('HEAD');
  });

  it("marks the checked-out branch's chip, its bigger check and its connector (J21); other rows' aren't", () => {
    const head: RefLabel = { row: 0, name: 'main', local: 'refs/heads/main', tag: false, isHead: true, worktree: null, checkedOut: null, remotes: [] };
    const { container, rerender } = render(<RefLabels labels={[head, remoteOnly('topic', 'origin')]} color={0} membership={{ name: 'x', color: 1, ref: 'refs/heads/x' }} />);
    const labels = container.querySelector('.ref-labels')!;
    expect(labels).toHaveClass('ref-labels-head');
    expect(labels.querySelector(':scope > .ref-label')).toHaveClass('ref-label-head');
    expect(labels.querySelector(':scope > .ref-label [aria-label="HEAD"]')).toHaveClass('ref-head-check');
    // The dimmed membership chip is never the head chip.
    expect(labels.querySelector('.ref-label-dim')).not.toHaveClass('ref-label-head');
    rerender(<RefLabels labels={[remoteOnly('topic', 'origin')]} color={0} />);
    expect(container.querySelector('.ref-labels')).not.toHaveClass('ref-labels-head');
    expect(container.querySelector('.ref-label-head')).toBeNull();
  });

  it('outline source icons (laptop, generic remote) are a step bigger than the filled brand marks, so they read the same size', () => {
    const label: RefLabel = {
      row: 0, name: 'dev', local: 'refs/heads/dev', tag: false, isHead: false, worktree: null, checkedOut: null,
      remotes: [{ fullName: 'refs/remotes/origin/dev', remote: 'origin', host: 'gitlab.example.com', hostKind: 'gitlab' }, remote('backup', 'dev')],
    };
    const { container } = render(<RefLabels labels={[label]} color={0} />);
    const chip = container.querySelector('.ref-label')!;
    const sizeOf = (sel: string) => chip.querySelector(sel)!.getAttribute('width');
    expect(sizeOf('[aria-label="local"]')).toBe('14');
    expect(sizeOf('[data-host-kind="generic"]')).toBe('14');
    expect(sizeOf('[data-host-kind="gitlab"]')).toBe('12');
  });

  /** A source icon's hover target in the expanded (hovered) copy, the one the pointer can reach. */
  const fullIcon = (container: HTMLElement, aria: string) => container.querySelector('.ref-label-full')!.querySelector(`[aria-label="${aria}"]`)!.closest('.ref-icon')!;

  it('shows a remote-only label by its branch part; its remote icon\'s (instant) tooltip reads `origin → <branch> (Remote)` (H12)', () => {
    const { container } = render(<RefLabels labels={[remoteOnly('p/janderson/foo', 'origin')]} color={0} />);
    const chip = screen.getByText('p/janderson/foo').closest('.ref-label')!;
    expect(chip).not.toHaveAttribute('title');
    fireEvent.mouseEnter(chip);
    // The name itself has no tooltip (F9).
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(fullIcon(container, 'remote origin'));
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('origin → p/janderson/foo (Remote)');
    // The remote name is highlighted, the branch dimmed (tooltip.css / graph.css).
    expect(tip.querySelector('.ref-tip-remote')!.textContent).toBe('origin');
    expect(tip.querySelector('.ref-tip-branch')!.textContent).toBe('p/janderson/foo');
  });

  it('one chip per branch name: one icon per ref, each with its own short-name tooltip (no refs/heads/)', () => {
    const label: RefLabel = { row: 0, name: 'foo', local: 'refs/heads/foo', tag: false, isHead: true, worktree: null, checkedOut: null, remotes: [remote('origin', 'foo'), remote('upstream', 'foo')] };
    const { container } = render(<RefLabels labels={[label]} color={0} />);
    const chip = container.querySelector('.ref-labels > .ref-label')!;
    expect(chip.querySelectorAll(':scope > .ref-icon [aria-label="local"]')).toHaveLength(1);
    expect(chip.querySelector('[aria-label="remote origin"]')).not.toBeNull();
    expect(chip.querySelector('[aria-label="remote upstream"]')).not.toBeNull();
    fireEvent.mouseEnter(chip);
    expect(screen.queryByRole('tooltip')).toBeNull();
    for (const [aria, tip] of [['local', 'foo (Local)'], ['remote origin', 'origin → foo (Remote)'], ['remote upstream', 'upstream → foo (Remote)']]) {
      const icon = fullIcon(container, aria);
      fireEvent.mouseEnter(icon);
      expect(screen.getByRole('tooltip').textContent).toBe(tip);
      // Back onto the copy's name: still over the chip, so it stays expanded, with no tooltip.
      fireEvent.mouseLeave(icon, { relatedTarget: container.querySelector('.ref-name-full') });
      expect(screen.queryByRole('tooltip')).toBeNull();
    }
    expect(document.body.textContent).not.toMatch(/refs\//);
  });

  it('a remote icon keeps the upstream\'s own branch name when it differs from the local one', () => {
    const label: RefLabel = { row: 0, name: 'foo', local: 'refs/heads/foo', tag: false, isHead: false, worktree: null, checkedOut: null, remotes: [remote('origin', 'feature/foo')] };
    const { container } = render(<RefLabels labels={[label]} color={0} />);
    fireEvent.mouseEnter(container.querySelector('.ref-labels > .ref-label')!);
    fireEvent.mouseEnter(fullIcon(container, 'remote origin'));
    expect(screen.getByRole('tooltip').textContent).toBe('origin → feature/foo (Remote)');
  });

  it('the resting chip\'s icons show their tooltip too, at once: the pointer can land on one before the expanded copy covers it (H12)', () => {
    const label: RefLabel = { row: 0, name: 'foo', local: 'refs/heads/foo', tag: false, isHead: false, worktree: null, checkedOut: null, remotes: [] };
    const { container } = render(<RefLabels labels={[label]} color={0} />);
    fireEvent.mouseEnter(container.querySelector('.ref-labels > .ref-label > .ref-icon')!);
    expect(screen.getByRole('tooltip').textContent).toBe('foo (Local)');
  });

  it('stays expanded while the pointer moves onto the expanded copy (including its icons), collapses on leaving it', () => {
    const label: RefLabel = { row: 0, name: LONG, local: `refs/heads/${LONG}`, tag: false, isHead: false, worktree: null, checkedOut: null, remotes: [remote('origin', LONG)] };
    const { container } = render(<div data-testid="outside"><RefLabels labels={[label]} color={0} /></div>);
    const chip = container.querySelector('.ref-labels > .ref-label')!;
    fireEvent.mouseEnter(chip);
    const icon = fullIcon(container, 'remote origin');
    // Onto the copy's cloud icon, past the resting chip's right edge: still expanded, and the
    // icon's tooltip shows.
    fireEvent.mouseLeave(chip, { relatedTarget: icon });
    fireEvent.mouseEnter(icon);
    expect(container.querySelector('.ref-label-full')).not.toBeNull();
    expect(screen.getByRole('tooltip').textContent).toBe(`origin → ${LONG} (Remote)`);
    fireEvent.mouseLeave(chip, { relatedTarget: screen.getByTestId('outside') });
    expect(container.querySelector('.ref-label-full')).toBeNull();
  });

  describe('the hover stack (K77)', () => {
    const three = [remoteOnly('main', 'origin'), remoteOnly('foo', 'origin', 'upstream'), remoteOnly(LONG, 'fork')];
    const rows = (c: HTMLElement) => [...c.querySelectorAll('.ref-stack > .ref-stack-row')];

    it('hovering the chip or the +N badge stacks one full row per label; nothing renders before; leaving closes it', () => {
      const { container } = render(<RefLabels labels={three} color={0} />);
      expect(container.querySelector('.ref-stack')).toBeNull();
      for (const el of [container.querySelector('.ref-labels > .ref-label')!, screen.getByText('+2')]) {
        fireEvent.mouseEnter(el);
        expect(rows(container).map((r) => r.querySelector('.ref-name-full')!.textContent)).toEqual(['main', 'foo', LONG]);
        expect(el.contains(container.querySelector('.ref-stack'))).toBe(true);
        expect(container.querySelector('.ref-label-full')).toBeNull();
        // Rows keep their source icons (and their tooltips).
        expect(rows(container)[1].querySelectorAll('.ref-icon')).toHaveLength(2);
        fireEvent.mouseLeave(el);
        expect(container.querySelector('.ref-stack')).toBeNull();
      }
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('is never compact, even in a compact column', () => {
      const { container } = render(<RefLabels labels={three} color={0} compact />);
      fireEvent.mouseEnter(container.querySelector('.ref-labels > .ref-label')!);
      expect(rows(container)).toHaveLength(3);
      expect(rows(container)[0].querySelector('.ref-name-full')!.textContent).toBe('main');
    });

    it("a row's hover starts that ref's branch focus, leaving or unmounting ends it", () => {
      const calls: (readonly string[] | null)[] = [];
      const { container, unmount } = render(<RefLabels labels={three} color={0} onBranchHover={(r) => calls.push(r)} />);
      fireEvent.mouseEnter(screen.getByText('+2'));
      fireEvent.mouseEnter(rows(container)[2]);
      expect(calls.at(-1)).toEqual(chipRefs(three[2]));
      fireEvent.mouseLeave(rows(container)[2], { relatedTarget: container.querySelector('.ref-stack') });
      expect(calls.at(-1)).toBeNull();
      fireEvent.mouseEnter(rows(container)[1]);
      expect(calls.at(-1)).toEqual(chipRefs(three[1]));
      unmount();
      expect(calls.at(-1)).toBeNull();
    });

    it("a row's right-click opens that label's menu (once, not the first chip's)", () => {
      const seen: string[] = [];
      const { container } = render(<RefLabels labels={three} color={0} onContextMenu={(l) => seen.push(l.name)} />);
      fireEvent.mouseEnter(container.querySelector('.ref-labels > .ref-label')!);
      fireEvent.contextMenu(rows(container)[1]);
      fireEvent.contextMenu(rows(container)[0]);
      expect(seen).toEqual(['foo', 'main']);
    });

    it('a single label keeps the one-chip copy and has no +N or stack', () => {
      const { container } = render(<RefLabels labels={[three[0]]} color={0} />);
      fireEvent.mouseEnter(container.querySelector('.ref-labels > .ref-label')!);
      expect(container.querySelector('.ref-label-full')).not.toBeNull();
      expect(container.querySelector('.ref-stack')).toBeNull();
      expect(container.querySelector('.ref-more')).toBeNull();
    });
  });

  it('a membership chip goes after the real chips and the +N badge, before the connector, without changing them (F7)', () => {
    const tagOnly: RefLabel = { row: 0, name: 'v1', local: null, remotes: [], tag: true, isHead: false, worktree: null, checkedOut: null };
    const membership = { name: 'main', color: 2, ref: 'refs/heads/main' };
    const { container } = render(<RefLabels labels={[tagOnly, remoteOnly('x', 'origin')]} color={0} membership={membership} />);
    const kids = [...container.querySelector('.ref-labels')!.children].map((el) => el.className);
    expect(kids).toEqual(['ref-label', 'ref-more', 'ref-dim-slot', 'ref-connector']);
    expect(container.querySelector('.ref-more')).toHaveTextContent('+1');
    const slot = container.querySelector('.ref-dim-slot')!;
    // The line filler first (it carries the connector line when the chip is dropped), then the chip.
    expect([...slot.children].map((el) => el.className)).toEqual(['ref-dim-fill', 'ref-label ref-label-dim']);
    expect(slot.querySelector('.ref-label-dim')).toHaveTextContent('main');
  });

  it('the membership chip expands like the others while hovered: an untruncated copy over it, gone on leaving (J6)', () => {
    const tagOnly: RefLabel = { row: 0, name: 'v1', local: null, remotes: [], tag: true, isHead: false, worktree: null, checkedOut: null };
    const membership = { name: LONG, color: 1, ref: `refs/heads/${LONG}` };
    // Alone on its row, and after a real chip (in the slot).
    for (const labels of [[], [tagOnly]]) {
      const { container, unmount } = render(<RefLabels labels={labels} color={0} membership={membership} />);
      const dim = container.querySelector('.ref-label-dim')!;
      expect(container.querySelector('.ref-label-full')).toBeNull();
      fireEvent.mouseEnter(dim);
      const full = dim.querySelector(':scope > .ref-label-full');
      expect(full).toHaveTextContent(LONG);
      expect(full).toHaveAttribute('aria-hidden', 'true');
      expect(full!.querySelector('.ref-name-full')).not.toBeNull();
      // Still no tooltip on the name (F9).
      expect(screen.queryByRole('tooltip')).toBeNull();
      fireEvent.mouseLeave(dim);
      expect(container.querySelector('.ref-label-full')).toBeNull();
      unmount();
    }
  });

  it('with no chips of its own, the membership chip stands alone (no connector)', () => {
    const { container } = render(<RefLabels labels={[]} color={0} membership={{ name: 'main', color: 0, ref: 'refs/heads/main' }} />);
    expect(container.querySelector('.ref-label-dim')).toHaveTextContent('main');
    expect(container.querySelector('.ref-connector')).toBeNull();
    expect(container.querySelector('.ref-dim-slot')).toBeNull();
  });

  it('hovering the chip floats an untruncated copy over it, and leaving collapses it', () => {
    const label: RefLabel = { row: 0, name: LONG, local: `refs/heads/${LONG}`, tag: false, isHead: false, worktree: null, checkedOut: null, remotes: [] };
    const { container } = render(<RefLabels labels={[label]} color={0} />);
    expect(container.querySelector('.ref-label-full')).toBeNull();
    const chip = container.querySelector('.ref-labels > .ref-label')!;
    fireEvent.mouseEnter(chip);

    const full = container.querySelector('.ref-label-full')!;
    expect(full).not.toBeNull();
    expect(full).toHaveAttribute('aria-hidden', 'true');
    // An overlay (absolutely positioned inside the chip), not a width change of the in-flow chip.
    expect(chip.contains(full)).toBe(true);
    const name = full.querySelector('.ref-name-full')!;
    expect(name.textContent).toBe(LONG);
    // The full name: none of the truncating class or styles.
    expect(name).not.toHaveClass('ref-name');
    expect(full.querySelector('.ref-name')).toBeNull();
    expect((name as HTMLElement).style.textOverflow).toBe('');
    expect((full as HTMLElement).style.maxWidth).toBe('');
    // The in-flow chip and the connector are untouched.
    expect(chip.querySelector(':scope > .ref-name')!.textContent).toBe(LONG);
    expect(container.querySelector('.ref-connector')).not.toBeNull();

    fireEvent.mouseLeave(chip);
    expect(container.querySelector('.ref-label-full')).toBeNull();
  });
});

describe('RefLabels and the theme', () => {
  it("colours the chip, its connector and the dimmed membership chip in the theme's lanes, overrides included", () => {
    act(() => useTheme.getState().set('default-dark', {}));
    const { container } = render(<RefLabels labels={[remoteOnly('topic', 'origin')]} color={2} membership={{ name: 'x', color: 3, ref: 'refs/heads/x' }} />);
    const lane = () => (container.querySelector('.ref-labels') as HTMLElement).style.getPropertyValue('--lane-color');
    const dim = () => (container.querySelector('.ref-label-dim') as HTMLElement).style.getPropertyValue('--lane-color');
    expect(lane()).toBe(THEMES['default-dark'].graph[2]);
    act(() => useTheme.getState().set('dracula', { dracula: [null, null, '#123456'] }));
    expect(lane()).toBe('#123456');
    expect(dim()).toBe(THEMES.dracula.graph[3]);
    act(() => useTheme.getState().set('default-dark', {}));
  });
});

describe('RefLabels, several labels (K104)', () => {
  const local = (name: string, isHead = false): RefLabel => ({ row: 0, name, local: `refs/heads/${name}`, tag: false, isHead, worktree: null, checkedOut: null, remotes: [] });
  const labels = [local('dev', true), local('prod'), local('staging')];

  it('shows every chip side by side when the column has room, with no +N', () => {
    const { container } = render(<RefLabels labels={labels} color={0} width={600} />);
    const chips = container.querySelectorAll('.ref-labels > .ref-label');
    expect([...chips].map((c) => c.textContent)).toEqual(['dev', 'prod', 'staging']);
    expect(chips[0]).toHaveClass('ref-label-head');
    expect(chips[1]).not.toHaveClass('ref-label-head');
    expect(container.querySelector('.ref-more')).toBeNull();
  });

  it('shows what fits and collapses the rest into a lane-coloured +N (lit when the first chip is HEAD)', () => {
    const { container } = render(<RefLabels labels={labels} color={0} width={160} />);
    expect(container.querySelectorAll('.ref-labels > .ref-label')).toHaveLength(2);
    const more = container.querySelector('.ref-more')!;
    expect(more).toHaveTextContent('+1');
    expect(more).toHaveClass('ref-more-head');
  });

  it('compact, or no width: the first chip and +N; the badge is not lit off the active branch', () => {
    const { container, rerender } = render(<RefLabels labels={labels} color={0} width={600} compact />);
    expect(container.querySelectorAll('.ref-labels > .ref-label')).toHaveLength(1);
    expect(container.querySelector('.ref-more')).toHaveTextContent('+2');
    rerender(<RefLabels labels={[local('prod'), local('dev')]} color={0} />);
    expect(container.querySelector('.ref-more')).toHaveTextContent('+1');
    expect(container.querySelector('.ref-more')).not.toHaveClass('ref-more-head');
  });
});
