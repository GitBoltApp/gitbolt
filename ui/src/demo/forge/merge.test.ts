import { describe, expect, it } from 'vitest';
import { forgeReadHandlers as r } from '../handlers/forgeReads';
import { forgeWriteHandlers as w } from '../handlers/forgeWrites';
import { labCtx } from './testkit';

const opts = { method: null, squash: null, deleteSourceBranch: null, expectedSha: null };

describe('the demo forge: merging', () => {
  it('merges a mergeable MR; refuses one that isn\'t, or whose head moved', async () => {
    const { ctx, id, forge } = await labCtx();
    forge.gitEffects = false;
    await expect(w.forgeMerge({ repo: id, number: 1, options: opts }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: "GitLab can't merge !1 now: refresh to see why" });
    await expect(w.forgeMerge({ repo: id, number: 4, options: { ...opts, expectedSha: 'f'.repeat(40) } }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: '!4 changed since it was loaded: refresh and try again' });
    const m = await w.forgeMerge({ repo: id, number: 4, options: { ...opts, deleteSourceBranch: true } }, ctx);
    expect(m).toMatchObject({ number: 4, state: 'merged' });
  });

  it('auto-merge waits for a running pipeline, and is cancelled', async () => {
    const { ctx, id, forge } = await labCtx();
    forge.gitEffects = false;
    forge.fake.mr('orbital/forge-lab', 6).pipeline = 'running';
    const set = await w.forgeSetAutoMerge({ repo: id, number: 6, options: opts }, ctx);
    expect(set).toMatchObject({ state: 'open', autoMerge: { enabledBy: { username: 'you' } } });
    expect((await w.forgeCancelAutoMerge({ repo: id, number: 6 }, ctx)).autoMerge).toBeNull();
    await expect(w.forgeCancelAutoMerge({ repo: id, number: 6 }, ctx)).rejects.toMatchObject({ message: "!6 isn't set to auto-merge any more: refresh" });
  });

  it('edits the title (a draft keeps its prefix), labels and reviewers; marks ready', async () => {
    const { ctx, id, forge } = await labCtx();
    forge.gitEffects = false;
    const e = await w.forgeEditMr({ repo: id, number: 2, edit: { title: 'A radar panel', description: null, labels: ['hud'], reviewers: { add: [102], remove: [] } } }, ctx);
    expect(e).toMatchObject({ title: 'A radar panel', state: 'draft', labels: ['hud'] });
    expect((await w.forgeSetDraft({ repo: id, number: 2, draft: false }, ctx)).state).toBe('open');
    await expect(w.forgeEditMr({ repo: id, number: 2, edit: { title: '  ', description: null, labels: null } }, ctx)).rejects.toMatchObject({ message: "The title can't be empty" });
    expect((await r.forgeMrDetail({ repo: id, number: 2 }, ctx)).value.reviewers.map((u) => u.username)).toEqual(['grace']);
  });

  it('GitLab\'s rebase: the made-up head without the origin, its refusals, and a seeded failure', async () => {
    const { ctx, id, forge } = await labCtx();
    forge.gitEffects = false;
    const m = await w.forgeUpdateBranch({ repo: id, number: 4, how: 'rebaseSkipCi', expectedSha: null }, ctx);
    expect(m).toMatchObject({ headSha: (0xb0000 + 4 * 0x100 + 1).toString(16).padStart(40, '0'), pipeline: null });
    forge.fake.mr('orbital/forge-lab', 6).rebaseForbidden = true;
    await expect(w.forgeUpdateBranch({ repo: id, number: 6, how: 'rebase', expectedSha: null }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: "GitLab can't rebase !6: Cannot push to source branch" });
    forge.fake.mr('orbital/forge-lab', 5).rebaseError = 'Rebase failed: conflict in hold.rs';
    await expect(w.forgeUpdateBranch({ repo: id, number: 5, how: 'rebase', expectedSha: '5'.repeat(40) }, ctx)).rejects.toMatchObject({ message: "GitLab couldn't rebase !5: Rebase failed: conflict in hold.rs" });
    // A failure from before the head moved isn't this rebase's.
    expect((await w.forgeUpdateBranch({ repo: id, number: 5, how: 'rebase', expectedSha: 'e'.repeat(40) }, ctx)).number).toBe(5);
  });

  it('refuses people GitLab didn\'t add, and says when the project keeps only one', async () => {
    const { ctx, id, forge } = await labCtx();
    forge.gitEffects = false;
    await expect(w.forgeEditMr({ repo: id, number: 4, edit: { title: null, description: null, labels: null, assignees: { add: [999], remove: [] } } }, ctx)).rejects.toMatchObject({ message: "GitLab didn't add user 999 as an assignee: are they a member of orbital/forge-lab?" });
    forge.fake.seed.projects[0].singlePeople = true;
    await expect(w.forgeEditMr({ repo: id, number: 4, edit: { title: null, description: null, labels: null, reviewers: { add: [102, 103], remove: [] } } }, ctx)).rejects.toMatchObject({
      message: 'GitLab kept only Grace Hopper: this project allows one reviewer', detail: { kind: 'peopleLimit', role: 'reviewers' },
    });
    const t = forge.provider;
    const project = t.project('orbital/forge-lab');
    expect(t.retarget(project, 5, 'main')).toMatchObject({ targetBranch: 'main' });
    expect(t.setDraft(project, 5, true)).toMatchObject({ state: 'draft', title: 'Give the hold a capacity' });
  });
});
