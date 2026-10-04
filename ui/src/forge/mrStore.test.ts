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
