import { describe, expect, it } from 'vitest';
import type { CommitDetailsPayload } from '../api/gen/CommitDetailsPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { createRepoViewStore } from './store';
import { recordingServices } from './testServices';

// Selecting a commit asks at once for what the details header shows late otherwise: its
// signature (with the details, not after them) and the avatars of the people the graph doesn't
// draw (a different committer, co-authors); the same for the neighbours two rows either way.

const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((c) => c.repeat(40));
const row = (id: string): RowPayload => ({
  id, kind: 'commit', lane: 0, color: 0, segments: [], summary: id.slice(0, 1), bodyFirstLine: '', authorName: 'Ada', authorEmail: 'ada@example.com', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null,
});
const graph: GraphPayload = { rows: ids.map(row), labels: [], maxLanes: 1, pinnedRefs: [], head: { branch: 'refs/heads/main', target: ids[0], detached: false, unborn: false }, truncated: false, worktrees: [] };
const flush = () => new Promise((r) => setTimeout(r, 0));
const details = (id: string, committer: string, coAuthors: string[] = []): CommitDetailsPayload => ({
  id, parents: [], signed: true,
  author: { name: 'Ada', email: 'ada@example.com', time: 0 },
  committer: { name: 'GitHub', email: committer, time: 0 },
  coAuthors: coAuthors.map((email) => ({ name: email, email })),
});

function setup() {
  const asked: string[] = [];
  const prefetched: string[] = [];
  const rec = recordingServices({ avatars: { request: (email) => asked.push(email), prefetchOne: (email) => prefetched.push(email) } });
  const s = createRepoViewStore(1, '/r', graph, rec.services);
  return { ...rec, s, asked, prefetched };
}

describe('selecting a commit', () => {
  it('starts its signature check with the details, and its neighbours\' two rows either way', () => {
    const { s, calls } = setup();
    s.getState().selectRow(3, {});
    expect(calls).toContain(`details ${ids[3]}`);
    expect(calls).toContain(`signature ${ids[3]}`);
    // The neighbours' checks are prefetches (2 at a time, the selected one first).
    expect(calls.filter((c) => c.startsWith('signature')).length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((c) => c.startsWith('details')).sort()).toEqual([1, 2, 3, 4, 5].map((i) => `details ${ids[i]}`).sort());
  });

  it('asks for the committer\'s and co-authors\' avatars as soon as the details arrive; the neighbours\' only at prefetch priority', async () => {
    const { s, resolve, asked, prefetched } = setup();
    s.getState().selectRow(3, {});
    expect(asked).toEqual([]);
    resolve(`details ${ids[3]}`, details(ids[3], 'noreply@github.com', ['grace@example.com', 'linus@example.com']));
    await flush();
    expect(asked).toEqual(['ada@example.com', 'noreply@github.com', 'grace@example.com', 'linus@example.com']);
    expect(prefetched).toEqual([]);
    resolve(`details ${ids[5]}`, details(ids[5], 'margaret@example.com'));
    await flush();
    expect(prefetched).toContain('margaret@example.com');
    expect(asked).not.toContain('margaret@example.com');
  });

  it('asks at once when the details are cached already', async () => {
    const { s, resolve, asked } = setup();
    s.getState().selectRow(3, {});
    resolve(`details ${ids[2]}`, details(ids[2], 'committer@example.com', ['co@example.com']));
    await flush();
    asked.length = 0;
    s.getState().selectRow(2, {});
    expect(asked).toEqual(expect.arrayContaining(['committer@example.com', 'co@example.com']));
  });
});
