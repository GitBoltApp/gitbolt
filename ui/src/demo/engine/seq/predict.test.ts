import { describe, expect, it } from 'vitest';
import type { RebaseRow } from '../../../api/gen/RebaseRow';
import { readCommit } from '../read/commitText';
import { makeTestRepo, type TestRepo } from '../read/testkit';
import { rebaseLab } from './fixtures';
import { predict } from './predict';

async function labRows(t: TestRepo): Promise<string[]> {
  const out: string[] = [];
  for (let at = await t.rev('lab'), stop = (await readCommit(t.repo, await t.rev('main'))).parents[0]; at !== stop; at = (await readCommit(t.repo, at)).parents[0]) out.push(at);
  return out; // newest first, as the request sends them
}
const picks = (oids: string[]): RebaseRow[] => oids.map((oid) => ({ oid, action: 'pick' }));

describe('predictRebase', () => {
  it('predicts L2 onto main, and nothing after it', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const rows = await labRows(t);
    const p = await predict(t.repo, 'k1', t.dir, 'main', picks(rows));
    expect(p.off).toBeNull();
    expect(p.rows.map((r) => r.conflicts)).toEqual([[], ['notes.txt'], [], [], [], []]);
    expect(p.rows.map((r) => r.oid)).toEqual([...rows].reverse());
  });

  it('moving L4 above L3 predicts a conflict there; dropped rows are left out', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const [l6, l5, l4, l3, l2, l1] = await labRows(t);
    const p = await predict(t.repo, 'k2', t.dir, (await readCommit(t.repo, await t.rev('main'))).parents[0], picks([l6, l5, l3, l4, l2, l1]).map((r) => (r.oid === l6 ? { ...r, action: 'drop' as const } : r)));
    expect(p.rows.map((r) => r.oid)).toEqual([l1, l2, l4, l3, l5]);
    expect(p.rows.find((r) => r.oid === l4)!.conflicts).toEqual(['notes.txt']);
  });

  it('dropping L2 removes the later conflict; a fixup row merges like a pick', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const [l6, l5, l4, l3, l2, l1] = await labRows(t);
    const rows: RebaseRow[] = [l6, l5, l4, l3, l2, l1].map((oid) => ({ oid, action: oid === l2 ? 'drop' : oid === l5 ? 'fixup' : 'pick' }));
    const p = await predict(t.repo, 'k5', t.dir, 'main', rows);
    // git's own rebase -i of the same todo runs clean (scratch repo check).
    expect(p.off).toBeNull();
    expect(p.rows.every((r) => r.conflicts.length === 0)).toBe(true);
    expect(p.rows.map((r) => r.oid)).toEqual([l1, l3, l4, l5, l6]);
  });

  it('L4 before L3 with L2 dropped, onto main: the first conflict is L4, as git stops there', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const [, l5, l4, l3, l2, l1] = await labRows(t);
    const rows: RebaseRow[] = [l5, l3, l4, l2, l1].map((oid) => ({ oid, action: oid === l2 ? 'drop' : 'pick' }));
    const p = await predict(t.repo, 'k7', t.dir, 'main', rows);
    expect(p.rows.filter((r) => r.conflicts.length).map((r) => [r.oid, r.conflicts])).toEqual([[l4, ['notes.txt']]]);
  });

  it('is off for long ranges, and superseded by a newer ask', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const many = Array.from({ length: 301 }, (_, i) => ({ oid: String(i).padStart(40, '0'), action: 'pick' as const }));
    expect(await predict(t.repo, 'k3', t.dir, 'main', many)).toEqual({ rows: [], off: 'Prediction is off for ranges over 300 commits' });
    const rows = picks(await labRows(t));
    const first = predict(t.repo, 'k4', t.dir, 'main', rows);
    const second = predict(t.repo, 'k4', t.dir, 'main', rows);
    expect(await first).toEqual({ rows: [], off: 'Superseded' });
    expect((await second).off).toBeNull();
  });

  it('turns off for an unknown commit', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    expect(await predict(t.repo, 'k6', t.dir, 'main', picks(['1'.repeat(40)]))).toEqual({ rows: [], off: "Couldn't predict conflicts" });
  });
});
