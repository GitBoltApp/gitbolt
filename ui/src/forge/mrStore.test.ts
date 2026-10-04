import { describe, expect, it } from 'vitest';
import type { LocalBranch } from '../api/gen/LocalBranch';
import type { SidebarPayload } from '../api/gen/SidebarPayload';
import { staleText } from './ForgeStale';
import { EMPTY_FORGE, knownMr, mrForLabel, mrForUpstream, upstreamRefsOf, type TabForge } from './mrStore';
import { detailOf, mrOf } from './testMrs';

const forge = (over: Partial<TabForge> = {}): TabForge => ({ ...EMPTY_FORGE, kind: 'gitlab', ...over });

describe('the forge store (spec #4 §4 "4B")', () => {
  it("finds a chip's MR through its remote refs first, else its local branch's upstream", () => {
    const f = forge({ byRef: { 'refs/remotes/origin/dev': mrOf(12), 'refs/remotes/origin/old': mrOf(9) }, upstreams: { 'refs/heads/old': 'refs/remotes/origin/old' } });
    expect(mrForLabel(f, { local: 'refs/heads/dev', remotes: [{ fullName: 'refs/remotes/origin/dev' }] })).toEqual({ mr: mrOf(12), via: 'refs/remotes/origin/dev' });
    expect(mrForLabel(f, { local: 'refs/heads/old', remotes: [] })).toEqual({ mr: mrOf(9), via: 'local' });
    expect(mrForLabel(f, { local: 'refs/heads/x', remotes: [] })).toBeNull();
    expect(mrForUpstream(f, 'refs/remotes/origin/dev')?.number).toBe(12);
    expect(mrForUpstream(f, null)).toBeNull();
  });

  it('knows an MR from its detail, the list or a badge', () => {
    const f = forge({ details: { 5: { value: detailOf(mrOf(5, { title: 'From detail' })), at: 1 } }, byRef: { r: mrOf(9) } });
    expect(knownMr(f, 5)?.title).toBe('From detail');
    expect(knownMr(f, 9)?.number).toBe(9);
    expect(knownMr(f, 1)).toBeNull();
  });

  it('asks about the upstreams of the local branches, newest tip first', () => {
    const b = (name: string, upstream: string | null, tipTime: number) => ({ name, fullName: `refs/heads/${name}`, upstream, tipTime, gone: false }) as LocalBranch;
    const sidebar = { locals: [b('dev', 'refs/remotes/origin/dev', 5), b('old', 'refs/remotes/origin/old', 9), b('loose', null, 99), b('twin', 'refs/remotes/origin/dev', 1)] } as SidebarPayload;
    const { refs, upstreams } = upstreamRefsOf(sidebar);
    expect(refs).toEqual(['refs/remotes/origin/old', 'refs/remotes/origin/dev']);
    expect(upstreams['refs/heads/twin']).toBe('refs/remotes/origin/dev');
    expect(upstreamRefsOf(null)).toEqual({ refs: [], upstreams: {} });
  });

  it('says how stale the data is after a failed poll', () => {
    expect(staleText(forge())).toBeNull();
    const now = 1_791_115_200_000;
    expect(staleText(forge({ error: "Couldn't reach gitlab.example.com: timed out", updatedAt: now - 120_000 }), now)).toBe("Couldn't refresh: Couldn't reach gitlab.example.com: timed out. Last updated 2 minutes ago");
    expect(staleText(forge({ error: 'boom', updatedAt: null }), now)).toBe("Couldn't refresh: boom.");
  });
});

// --- 4D T5 ---
it('also asks about a branch pushed without an upstream, through its push target (the merged bottom of a stack)', () => {
  const b = (name: string, upstream: string | null, pushTarget: string | null) => ({ name, fullName: `refs/heads/${name}`, upstream, pushTarget, tipTime: 1, gone: false }) as LocalBranch;
  const { refs, upstreams } = upstreamRefsOf({ locals: [b('a', null, 'origin/a'), b('b', 'refs/remotes/origin/b', 'origin/other'), b('c', null, null)] } as SidebarPayload);
  expect(refs).toEqual(['refs/remotes/origin/a', 'refs/remotes/origin/b']);
  expect(upstreams).toEqual({ 'refs/heads/a': 'refs/remotes/origin/a', 'refs/heads/b': 'refs/remotes/origin/b' });
});
// --- end 4D T5 ---

it("asks first about the targets of open MRs from local branches when no local branch has them (a stack's deleted merged bottom), within the lookup cap", () => {
  const b = (name: string, tipTime: number) => ({ name, fullName: `refs/heads/${name}`, upstream: `refs/remotes/origin/${name}`, pushTarget: null, tipTime, gone: false }) as LocalBranch;
  const newer = Array.from({ length: 30 }, (_, i) => b(`topic/${i}`, 100 + i));
  const sidebar = { locals: [b('feature/b', 1), b('feature/c', 2), b('main', 3), ...newer] } as SidebarPayload;
  const byRef = {
    'refs/remotes/origin/feature/b': mrOf(2, { sourceBranch: 'feature/b', targetBranch: 'feature/a' }),
    'refs/remotes/origin/feature/c': mrOf(3, { sourceBranch: 'feature/c', targetBranch: 'feature/b' }),
    'refs/remotes/origin/topic/0': mrOf(4, { sourceBranch: 'topic/0', targetBranch: 'main' }),
    'refs/remotes/origin/topic/1': mrOf(5, { sourceBranch: 'topic/1', targetBranch: 'gone/merged', state: 'merged' }),
  };
  const f = { byRef, upstreams: {}, remote: 'origin', project: { defaultBranch: 'main' } as TabForge['project'] };
  const { refs, upstreams } = upstreamRefsOf(sidebar, f);
  expect(refs[0]).toBe('refs/remotes/origin/feature/a');
  expect(refs.filter((r) => !sidebar.locals.some((l) => l.upstream === r))).toEqual(['refs/remotes/origin/feature/a']);
  expect(refs.indexOf('refs/remotes/origin/feature/a')).toBeLessThan(25); // the core looks up 25 (BRANCH_LOOKUPS)
  expect(upstreams['refs/heads/feature/a']).toBeUndefined();
  expect(upstreamRefsOf(sidebar).refs[0]).toBe('refs/remotes/origin/topic/29');
});
