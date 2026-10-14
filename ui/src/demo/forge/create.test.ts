import { describe, expect, it } from 'vitest';
import { remoteHandlers } from '../handlers/remotes';
import { forgeReadHandlers as r } from '../handlers/forgeReads';
import { forgeWriteHandlers as w } from '../handlers/forgeWrites';
import { NO_EXPECT } from '../engine/writeSeam';
import { revOf } from '../engine/seq/fixtures';
import { labWithOrigin } from './testkit';
import { splitMessage } from './hub';

describe('the demo forge: creating', () => {
  it("prefills from the branch's first commit, finds people and labels, creates the MR", async () => {
    const { t, ctx, id, wt } = await labWithOrigin();
    await t.branch('feature/scanner');
    await t.checkout('feature/scanner');
    await t.write('scanner.rs', 'scan\n');
    await t.commit('Add the scanner\n\nIt finds asteroids.');
    await t.write('scanner.rs', 'scan, tuned\n');
    await t.commit('Tune the scanner');
    await remoteHandlers.push({ repo: id, worktree: wt, branch: 'feature/scanner', target: { remote: 'origin', branch: 'feature/scanner' }, setUpstream: true, expect: NO_EXPECT }, ctx);
    const c = await w.forgeCreateContext({ repo: id, remote: 'origin', sourceRemote: 'origin', branch: 'feature/scanner', target: 'main' }, ctx);
    expect(c).toMatchObject({ sourceProject: 'orbital/forge-lab', templates: [], templatesLocal: false, firstCommit: { summary: 'Add the scanner', body: 'It finds asteroids.', count: 2 }, project: { path: 'orbital/forge-lab' } });
    expect((await w.forgeSearchUsers({ repo: id, remote: 'origin', query: 'gra' }, ctx)).map((u) => u.username)).toEqual(['grace']);
    expect((await w.forgeLabels({ repo: id, remote: 'origin', query: 'h' }, ctx)).map((l) => l.name)).toEqual(['hud']);
    const req = (title: string, draft: boolean) => ({ source: { project: 'orbital/forge-lab', branch: 'feature/scanner' }, targetBranch: 'main', title, description: 'It finds asteroids.', draft, reviewers: draft ? [102] : [], assignees: [], labels: draft ? ['hud'] : [], squash: null, deleteSourceBranch: null });
    const out = await w.forgeCreateMr({ repo: id, remote: 'origin', req: req('Add the scanner', true) }, ctx);
    expect(out).toMatchObject({ failed: [], mr: { number: 7, title: 'Draft: Add the scanner', state: 'draft', sourceBranch: 'feature/scanner', labels: ['hud'] } });
    // The new MR is on the origin's branch tip, with its diffs from where the branch left main.
    expect(out.mr.headSha).toBe(await revOf(t, 'feature/scanner'));
    expect((await w.forgeReviewDiff({ repo: id, number: 7 }, ctx)).files.map((f) => f.path)).toEqual(['scanner.rs']);
    expect((await r.forgeMrList({ repo: id, filter: 'all' }, ctx)).mrs[0].number).toBe(7);
    const again = req('Again', false);
    await expect(w.forgeCreateMr({ repo: id, remote: 'origin', req: again }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'gitlab.example.com: Another open merge request already exists for this source branch: !7' });
    await expect(w.forgeCompleteCreate({ repo: id, remote: 'origin', number: 7, req: again, parts: [] }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: "Adding reviewers, assignees and labels afterwards isn't supported by this forge yet" });
  });

  it('lists the target project\'s templates, Default first; without gitEffects the head is the fake\'s', async () => {
    const { ctx, id, forge } = await labWithOrigin();
    const dir = '.gitlab/merge_request_templates';
    forge.fake.seed.files['orbital/forge-lab'] = { [`${dir}/bug.md`]: '## Bug\r\n', [`${dir}/Default.md`]: 'Why?\n', [`${dir}/notes.txt`]: 'no', [`${dir}/sub/x.md`]: 'no' };
    const c = await w.forgeCreateContext({ repo: id, remote: 'origin', sourceRemote: 'origin', branch: 'main', target: 'main' }, ctx);
    expect(c.templates).toEqual([{ name: 'Default', path: `${dir}/Default.md`, body: 'Why?\n' }, { name: 'bug', path: `${dir}/bug.md`, body: '## Bug\n' }]);
    expect(c.firstCommit).toBeNull();
    forge.gitEffects = false;
    const out = await w.forgeCreateMr({ repo: id, remote: 'origin', req: { source: { project: 'orbital/forge-lab', branch: 'feature/new' }, targetBranch: 'main', title: 'New', description: '', draft: false, reviewers: [], assignees: [], labels: [], squash: null, deleteSourceBranch: null } }, ctx);
    expect(out.mr).toMatchObject({ number: 7, headSha: '1'.repeat(40), state: 'open' });
  });

  it('splits a message as the core does', () => {
    expect(splitMessage('Add login\r\n\r\n\r\nWhy.\n\n  - indented\n\n')).toEqual(['Add login', 'Why.\n\n  - indented']);
    expect(splitMessage('One line\n')).toEqual(['One line', '']);
    expect(splitMessage('Title\n\n   \n')).toEqual(['Title', '']);
  });
});
