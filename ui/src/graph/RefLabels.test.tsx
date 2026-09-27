import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RemoteRefLabel } from '../api/gen/RemoteRefLabel';
import { RefLabels } from './RefLabels';

const remote = (name: string, branch: string): RemoteRefLabel => ({ fullName: `refs/remotes/${name}/${branch}`, remote: name, hostKind: 'generic' });

const remoteOnly = (branch: string, ...remotes: string[]): RefLabel => ({
  row: 0, name: branch, local: null, tag: false, isHead: false, worktree: null,
  remotes: remotes.map((r) => remote(r, branch)),
});

const LONG = 'feature/a-very-long-branch-name-that-the-chip-truncates';

describe('RefLabels', () => {
  it('shows a remote-only label by its branch part, with the remote ref in the (instant) tooltip', () => {
    render(<RefLabels labels={[remoteOnly('p/janderson/foo', 'origin')]} color={0} />);
    const chip = screen.getByText('p/janderson/foo').closest('.ref-label')!;
    expect(chip).not.toHaveAttribute('title');
    fireEvent.mouseEnter(chip);
    expect(screen.getByRole('tooltip')).toHaveTextContent('origin/p/janderson/foo');
  });

  it('one chip per branch name: one icon per ref, and the tooltip lists exactly those refs', () => {
    const label: RefLabel = { row: 0, name: 'foo', local: 'refs/heads/foo', tag: false, isHead: true, worktree: null, remotes: [remote('origin', 'foo'), remote('upstream', 'foo')] };
    render(<RefLabels labels={[label]} color={0} />);
    const chip = screen.getByText('foo').closest('.ref-label')!;
    expect(chip.querySelectorAll('[aria-label="local"]')).toHaveLength(1);
    expect(chip.querySelector('[aria-label="remote origin"]')).not.toBeNull();
    expect(chip.querySelector('[aria-label="remote upstream"]')).not.toBeNull();
    fireEvent.mouseEnter(chip);
    expect(screen.getByRole('tooltip').textContent).toBe('refs/heads/foo\norigin/foo\nupstream/foo');
    fireEvent.mouseLeave(chip);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('gives remote-only labels their remote prefix back in the +N tooltip (every remote)', () => {
    render(<RefLabels labels={[remoteOnly('main', 'origin'), remoteOnly('foo', 'origin', 'upstream'), remoteOnly('bar', 'fork')]} color={0} />);
    const more = screen.getByText('+2');
    expect(more).not.toHaveAttribute('title');
    fireEvent.mouseEnter(more);
    expect(screen.getByRole('tooltip').textContent).toBe('origin/foo, upstream/foo\nfork/bar');
  });

  it('hovering the chip floats an untruncated copy over it, and leaving collapses it', () => {
    const label: RefLabel = { row: 0, name: LONG, local: `refs/heads/${LONG}`, tag: false, isHead: false, worktree: null, remotes: [] };
    const { container } = render(<RefLabels labels={[label, remoteOnly('x', 'origin')]} color={0} />);
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
    // The in-flow chip, the +N badge and the connector are untouched.
    expect(chip.querySelector(':scope > .ref-name')!.textContent).toBe(LONG);
    expect(container.querySelector('.ref-more')).toHaveTextContent('+1');
    expect(container.querySelector('.ref-connector')).not.toBeNull();

    fireEvent.mouseLeave(chip);
    expect(container.querySelector('.ref-label-full')).toBeNull();
  });
});
