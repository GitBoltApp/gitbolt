import { describe, expect, it } from 'vitest';
import { historyHandlers } from './history';
import { ADA, GRACE, LARS, fakeCtx, makeTestRepo, storyRepo } from '../engine/read/testkit';

async function repo() {
  const t = await makeTestRepo();
  await t.write('story.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n');
  await t.commit('Start the story', ADA);
  await t.write('story.txt', 'one\nTWO\nthree\nfour\nfive\nsix\n');
  const middle = await t.commit('Add the middle', GRACE);
  await t.remove('story.txt');
  await t.write('src/story.txt', 'one\nTWO\nthree\nfour\nfive\nsix!\n');
  await t.commit('Move the story under src', LARS);
  return { t, middle, ctx: fakeCtx(t.repo) };
}

describe('history handlers', () => {
  it('pages a file\'s history across its rename', async () => {
    const { t, ctx } = await repo();
    const page = (skip: number, limit: number) => historyHandlers.fileHistory({ repo: 1, worktree: t.dir, path: 'src/story.txt', skip, limit }, ctx);
    const all = await page(0, 200);
    expect(all.rows.map((r) => [r.summary, r.path, r.status])).toEqual([['Move the story under src', 'src/story.txt', 'R'], ['Add the middle', 'story.txt', 'M'], ['Start the story', 'story.txt', 'A']]);
    expect(all.more).toBe(false);
    const first = await page(0, 2);
    expect([first.rows.length, first.more]).toEqual([2, true]);
    const second = await page(2, 2);
    expect([second.rows.map((r) => r.summary), second.more]).toEqual([['Start the story'], false]);
    expect((await page(9, 2)).rows).toEqual([]);
  });

  it('cuts pages across the rename of the core fixture', async () => {
    const { t } = await storyRepo();
    const ctx = fakeCtx(t.repo);
    const page = (skip: number, limit: number) => historyHandlers.fileHistory({ repo: 1, worktree: t.dir, path: 'src/story.txt', skip, limit }, ctx);
    const a = await page(0, 2);
    expect([a.rows.map((r) => [r.summary, r.path, r.status]), a.more]).toEqual([
      [['Sharpen the opening', 'src/story.txt', 'M'], ['Move the story under src', 'src/story.txt', 'R']],
      true,
    ]);
    const b = await page(2, 2);
    expect([b.rows.map((r) => [r.summary, r.path, r.status, r.oldPath]), b.more]).toEqual([
      [['Add the middle', 'story.txt', 'M', null], ['Start the story', 'story.txt', 'A', null]],
      false,
    ]);
  });

  it('starts at a revision, and refuses option-like ones and escaping paths', async () => {
    const { t, middle, ctx } = await repo();
    const p = await historyHandlers.fileHistory({ repo: 1, worktree: t.dir, path: 'story.txt', rev: middle, skip: 0, limit: 200 }, ctx);
    expect(p.rows.map((r) => r.summary)).toEqual(['Add the middle', 'Start the story']);
    await expect(historyHandlers.fileHistory({ repo: 1, worktree: t.dir, path: 'src/story.txt', rev: '--all', skip: 0, limit: 5 }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'not a revision: --all' });
    await expect(historyHandlers.blame({ repo: 1, worktree: t.dir, rev: 'HEAD', path: '../x' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput' });
  });

  it('blames a file at a revision', async () => {
    const { t, ctx } = await repo();
    const b = await historyHandlers.blame({ repo: 1, worktree: t.dir, rev: 'HEAD', path: 'src/story.txt' }, ctx);
    expect(b.hunks.map((h) => [h.start, h.lines])).toEqual([[1, 1], [2, 1], [3, 3], [6, 1]]);
    expect(b.commits.map((c) => c.summary)).toEqual(['Start the story', 'Add the middle', 'Move the story under src']);
  });

  it('names the revision as spelled when a path is missing from it', async () => {
    const { t, ctx } = await repo();
    await expect(historyHandlers.blame({ repo: 1, worktree: t.dir, rev: 'HEAD', path: 'nope.txt' }, ctx)).rejects.toMatchObject({ kind: 'Other', message: 'no such path nope.txt in HEAD' });
    await expect(historyHandlers.blame({ repo: 1, worktree: t.dir, rev: 'HEAD~9', path: 'story.txt' }, ctx)).rejects.toMatchObject({ kind: 'NotFound' });
  });
});
