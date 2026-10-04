import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LocalBranch } from '../api/gen/LocalBranch';
import type { TagItem } from '../api/gen/TagItem';
import type { SideItem } from './model';

const lastPush = vi.fn(async () => ({ time: 100, kind: 'push' as const }));
vi.mock('../api/client', () => ({ api: { lastPush }, onEvent: vi.fn(() => () => {}) }));

const { HoverCard } = await import('./HoverCard');

const branch = (name: string): SideItem => ({
  key: `refs/heads/${name}`,
  kind: 'local',
  name,
  target: name,
  time: 10,
  branch: {
    name, fullName: `refs/heads/${name}`, target: name.padEnd(40, '0'), upstream: `refs/remotes/origin/${name}`,
    ahead: 0, behind: 0, gone: false, tipTime: 10, summary: '', author: 'a', isHead: false, worktree: null,
  } as LocalBranch,
});

/** Two rAFs: the hover card's own one-frame delay, then one more so its `.then` has run. */
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

describe('HoverCard lastPush request coalescing (fix round 1, item 7)', () => {
  it('hovering the same branch twice makes one request', async () => {
    const { unmount } = render(<HoverCard item={branch('main')} repoId={1} top={0} left={0} />);
    await nextFrame();
    expect(lastPush).toHaveBeenCalledTimes(1);
    unmount();

    render(<HoverCard item={branch('main')} repoId={1} top={0} left={0} />);
    await nextFrame();
    expect(lastPush).toHaveBeenCalledTimes(1);
  });

  it('a sweep over 5 rows makes at most 2 requests', async () => {
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    const { rerender } = render(<HoverCard item={branch(names[0])} repoId={2} top={0} left={0} />);
    for (const n of names.slice(1)) rerender(<HoverCard item={branch(n)} repoId={2} top={0} left={0} />);
    await nextFrame();
    expect(lastPush.mock.calls.length).toBeLessThanOrEqual(2);
    // The row the pointer settled on (the last one) is the one that actually asked.
    expect(lastPush).toHaveBeenLastCalledWith(2, 'refs/remotes/origin/echo');
  });
});

describe('HoverCard on a tag (UX round 3, M.2)', () => {
  const tag = (annotation?: TagItem['annotation']): SideItem => ({
    key: 'refs/tags/v1.0', kind: 'tag', name: 'v1.0', target: 'f'.repeat(40), time: 10,
    tag: { name: 'v1.0', fullName: 'refs/tags/v1.0', target: 'f'.repeat(40), time: 10, ...(annotation && { annotation }) },
  });
  it("shows an annotated tag's message and tagger, a lightweight tag's commit, and asks the backend nothing", async () => {
    lastPush.mockClear();
    const { getByRole, rerender } = render(<HoverCard item={tag({ message: 'Release notes', truncated: false, tagger: 'Grace', time: 1_700_000_000 })} repoId={3} top={0} left={0} />);
    expect(getByRole('tooltip')).toHaveTextContent('Release notes');
    expect(getByRole('tooltip').querySelector('.tag-tip-meta')).toHaveTextContent(/^Grace · /);
    rerender(<HoverCard item={tag()} repoId={3} top={0} left={0} />);
    expect(getByRole('tooltip')).toHaveTextContent('Lightweight tag');
    expect(getByRole('tooltip').querySelector('.tag-tip-meta')).toHaveTextContent('ffffff');
    await nextFrame();
    expect(lastPush).not.toHaveBeenCalled();
  });
});
