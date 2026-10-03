import { describe, expect, it, vi } from 'vitest';
import { laneColors } from './colors';

const label = (row: number, name: string, local: string | null, remotes: string[] = [], tag = false) =>
  ({ row, name, local, remotes: remotes.map((r) => ({ fullName: `refs/remotes/${r}`, remote: r.split('/')[0] })), tag, isHead: false, worktree: null, checkedOut: null });
vi.mock('../app/tabStores', () => ({
  tabStore: (id: string) => (id !== 't1' ? undefined : {
    getState: () => ({
      graph: {
        rows: [{ color: 0 }, { color: 3 }, { color: 5 }],
        labels: [label(0, 'topic', 'refs/heads/topic'), label(1, 'main', 'refs/heads/main', ['origin/main']), label(2, 'v1', null, [], true)],
      },
    }),
  }),
}));

describe('chip colours (UX R1.8)', () => {
  it('snapshots each branch tip row\'s lane colour, local and remote; tags and other tabs give none', () => {
    expect(laneColors('t1')).toEqual({ topic: 0, main: 3, 'origin/main': 3 });
    expect(laneColors('t2')).toEqual({});
  });
});
