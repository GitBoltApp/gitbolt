// The forge's write methods (the core's api.rs forge arms and forge/mrs.rs) on the demo's fake
// GitLab. The hub's own checks come first; a write that changes what the lists show forgets them
// (`wrote`), as the core's does. Reactions, resolving and subscribing leave the lists be.
import type { ForgeProject } from '../../api/gen/ForgeProject';
import type { DemoContext } from '../context';
import type { GbError } from '../../api/gen/GbError';
import { fail, viewOf } from '../engine/read/seam';
import { autoMergeIfReady, awaitPipeline, conflictsOnOrigin, describeNew, freshen, markStale, mergeWith, originTip, rebaseOnOrigin } from '../forge/gitEffects';
import { createContext, type DemoForge, forgeOf, forgeRemotes, mrTarget, projectForRemote, wrote } from '../forge/hub';
import { autoMergeRefused, type DemoGitLab, mergeRefused, statusError } from '../forge/provider';
import { checkComment, checkReviewMessage, GITLAB_DRAFT_POSITIONS, OLD_GITLAB_DRAFTS } from '../forge/review';
import { beforeMerge, mergeFailed, prefills, retargetMr, stackView, syncStack, versionAtLeast } from '../forge/stack';
import type { HandlerTable } from '../transport';

/** The repository's MR target and its provider, with a `done` that forgets the cached lists after a
 * write; MR `number` is brought up to date first (`freshen`). */
async function target(ctx: DemoContext, repo: number, number: number): Promise<{ f: DemoForge; p: DemoGitLab; project: ForgeProject; done: () => void }> {
  const demo = ctx.repos.get(repo);
  const f = await forgeOf(ctx, demo.fs);
  const t = await mrTarget(f, await forgeRemotes(ctx, repo));
  await freshen(ctx, f, t.project.path, number);
  return { f, p: f.provider, project: t.project, done: () => wrote(f, t.project.path) };
}

/** review.rs `can_draft`: the account's GitLab keeps a draft's line from 16.3; an unknown version is let through. */
function canDraft(p: DemoGitLab): boolean {
  const v = p.fake.seed.version;
  return !/^\s*\d+[.-]\d+/.test(v) || versionAtLeast(v, ...GITLAB_DRAFT_POSITIONS);
}

/** GitLab's 405, as the provider gets it: what a merge the origin couldn't take is refused with. */
const NOT_ALLOWED = () => statusError(405, { message: '405 Method Not Allowed' });

/** mrs.rs `react`'s name rule: ASCII lowercase, digits and `_+-`, 1 to 64 long. */
const EMOJI = /^[a-z0-9_+-]{1,64}$/;

export const forgeWriteHandlers: Pick<HandlerTable, 'forgeReply' | 'forgeApprove' | 'forgeRequestChanges' | 'forgeReview' | 'forgeSetSubscribed' | 'forgeReact' | 'forgeEditNote' | 'forgeDeleteNote' | 'forgeResolve' | 'forgeReviewDiff' | 'forgeReviewDrafts' | 'forgeAddDraft' | 'forgeEditDraft' | 'forgeDeleteDraft' | 'forgeSubmitReview' | 'forgeDiscardReview' | 'forgeCommentNow' | 'forgeMerge' | 'forgeSetAutoMerge' | 'forgeCancelAutoMerge' | 'forgeUpdateBranch' | 'forgeEditMr' | 'forgeSetDraft' | 'forgeCreateContext' | 'forgeSearchUsers' | 'forgeLabels' | 'forgeCreateMr' | 'forgeCompleteCreate' | 'forgeStack' | 'forgeSyncStack' | 'forgeRetarget'> = {
  forgeReply: async ({ repo, number, discussion, body }, ctx) => {
    if (body.trim() === '') fail('InvalidInput', 'Write a reply first');
    const t = await target(ctx, repo, number);
    const note = t.p.reply(t.project, number, { discussion, body });
    t.done();
    return note;
  },
  forgeApprove: async ({ repo, number }, ctx) => {
    const t = await target(ctx, repo, number);
    t.p.approve(t.project, number);
    // With `gitEffects`, the approval an auto-merge waited for lets it merge.
    await autoMergeIfReady(ctx, t.f, t.project.path, number);
    t.done();
    return null;
  },
  forgeRequestChanges: async ({ repo, number, body }, ctx) => {
    if (body.trim() === '') fail('InvalidInput', 'Say what to change first');
    const t = await target(ctx, repo, number);
    t.p.requestChangesSteps(t.project, number, body, false, { published: 0, eventError: null, bodyPosted: false, eventSent: false, fallback: false });
    t.done();
    return null;
  },
  forgeReview: async ({ repo, number, review }, ctx) => {
    checkReviewMessage(review, 0, null);
    const t = await target(ctx, repo, number);
    checkReviewMessage(review, 0, t.project.kind);
    const out = t.p.review(t.project, number, review);
    t.done();
    return out;
  },
  forgeSetSubscribed: async ({ repo, number, on }, ctx) => {
    const t = await target(ctx, repo, number);
    return t.p.setSubscribed(t.project, number, on);
  },
  forgeReact: async ({ repo, number, note, name, on }, ctx) => {
    if (!EMOJI.test(name)) fail('InvalidInput', "That isn't an emoji name");
    const t = await target(ctx, repo, number);
    return t.p.react(t.project, number, note, name, on);
  },
  forgeEditNote: async ({ repo, number, note, body }, ctx) => {
    if (body.trim() === '') fail('InvalidInput', "A comment can't be empty: delete it instead");
    const t = await target(ctx, repo, number);
    const edited = t.p.editNote(t.project, number, note, body);
    t.done();
    return edited;
  },
  forgeDeleteNote: async ({ repo, number, note }, ctx) => {
    const t = await target(ctx, repo, number);
    t.p.deleteNote(t.project, number, note);
    t.done();
    return null;
  },
  forgeResolve: async ({ repo, number, discussion, resolved }, ctx) => {
    const t = await target(ctx, repo, number);
    return t.p.resolve(t.project, number, discussion, resolved);
  },
  // --- review comments (the core's forge/review.rs) ---
  forgeReviewDiff: async ({ repo, number }, ctx) => {
    const t = await target(ctx, repo, number);
    return t.p.reviewDiff(t.project, number);
  },
  forgeReviewDrafts: async ({ repo, number }, ctx) => {
    const t = await target(ctx, repo, number);
    const d = t.p.reviewDrafts(t.project, number);
    return { ...d, canDraft: d.canDraft && canDraft(t.p) };
  },
  forgeAddDraft: async ({ repo, number, comment }, ctx) => {
    checkComment(comment);
    const t = await target(ctx, repo, number);
    if (!canDraft(t.p)) fail('InvalidInput', OLD_GITLAB_DRAFTS);
    return t.p.addDraft(t.project, number, comment);
  },
  forgeEditDraft: async ({ repo, number, id, body }, ctx) => {
    if (body.trim() === '') fail('InvalidInput', "A comment can't be empty: delete it instead");
    const t = await target(ctx, repo, number);
    return t.p.editDraft(t.project, number, id, body);
  },
  forgeDeleteDraft: async ({ repo, number, id }, ctx) => {
    const t = await target(ctx, repo, number);
    t.p.deleteDraft(t.project, number, id);
    return null;
  },
  // The drafts are counted first: with none, the message is as the composer's `review` needs it; with some, the drafts are the review.
  forgeSubmitReview: async ({ repo, number, review }, ctx) => {
    const t = await target(ctx, repo, number);
    const count = t.p.reviewDrafts(t.project, number).drafts.length;
    checkReviewMessage(review, count, t.project.kind);
    const out = await t.p.submitReview(t.project, number, review);
    t.done();
    return { ...out, published: count };
  },
  forgeDiscardReview: async ({ repo, number }, ctx) => {
    const t = await target(ctx, repo, number);
    return t.p.discardReview(t.project, number);
  },
  forgeCommentNow: async ({ repo, number, comment }, ctx) => {
    checkComment(comment);
    const t = await target(ctx, repo, number);
    const d = await t.p.commentNow(t.project, number, comment);
    t.done();
    return d;
  },
  // --- end review comments ---
  // --- merging, auto-merge, GitLab's rebase, edits and drafts (with `gitEffects`, on the origin too) ---
  // The origin's conflicts are checked before the guard moves any dependent, so a 405 from them never has to undo it (stack.rs `before_merge`, api.rs's arm).
  forgeMerge: async ({ repo, number, options }, ctx) => {
    const t = await target(ctx, repo, number);
    const r = await forgeRemotes(ctx, repo);
    await conflictsOnOrigin(ctx, t.f, t.project.path, number);
    const guard = await beforeMerge(t.f, r, number, options.deleteSourceBranch, ctx);
    let m;
    try {
      m = await mergeWith(ctx, t.f, t.project.path, number, () => t.p.merge(t.project, number, options), () => mergeRefused(number, NOT_ALLOWED()));
    } catch (e) {
      throw await mergeFailed(t.f, r, guard, e as GbError, ctx);
    }
    // The dependents now target the merge's target: worked out against it when next looked at.
    for (const n of guard.moved) markStale(t.f, t.project.path, n);
    t.done();
    return m;
  },
  // A pipeline that has passed merges it at once; one still running merges it when it passes.
  forgeSetAutoMerge: async ({ repo, number, options }, ctx) => {
    const t = await target(ctx, repo, number);
    await conflictsOnOrigin(ctx, t.f, t.project.path, number);
    const m = await mergeWith(ctx, t.f, t.project.path, number, () => t.p.setAutoMerge(t.project, number, options), () => autoMergeRefused(number, NOT_ALLOWED()));
    await awaitPipeline(ctx, t.f, t.project.path, number);
    t.done();
    return m;
  },
  forgeCancelAutoMerge: async ({ repo, number }, ctx) => {
    const t = await target(ctx, repo, number);
    const m = t.p.cancelAutoMerge(t.project, number);
    t.done();
    return m;
  },
  // `update_branch` in two: the PUT (refusals) with the origin's rebase around it, then the polls.
  forgeUpdateBranch: async ({ repo, number, how, expectedSha }, ctx) => {
    const t = await target(ctx, repo, number);
    await rebaseOnOrigin(ctx, t.f, t.project.path, number, () => t.p.startRebase(t.project, number, how));
    const m = t.p.finishRebase(t.project, number, expectedSha);
    t.done();
    return m;
  },
  forgeEditMr: async ({ repo, number, edit }, ctx) => {
    if (edit.title !== null && edit.title.trim() === '') fail('InvalidInput', "The title can't be empty");
    const t = await target(ctx, repo, number);
    const m = t.p.edit(t.project, number, edit);
    t.done();
    return m;
  },
  forgeSetDraft: async ({ repo, number, draft }, ctx) => {
    const t = await target(ctx, repo, number);
    const m = t.p.setDraft(t.project, number, draft);
    t.done();
    return m;
  },
  // --- creating (the core's forge/hub.rs create flow) ---
  forgeCreateContext: async ({ repo, remote, sourceRemote, branch, target: tgt }, ctx) => {
    const f = await forgeOf(ctx, ctx.repos.get(repo).fs);
    return createContext(ctx, f, repo, await forgeRemotes(ctx, repo), { remote, sourceRemote, branch, target: tgt });
  },
  forgeSearchUsers: async ({ repo, remote, query }, ctx) => {
    const f = await forgeOf(ctx, ctx.repos.get(repo).fs);
    return f.provider.searchUsers(await projectForRemote(f, await forgeRemotes(ctx, repo), remote), query);
  },
  forgeLabels: async ({ repo, remote, query }, ctx) => {
    const f = await forgeOf(ctx, ctx.repos.get(repo).fs);
    return f.provider.labels(await projectForRemote(f, await forgeRemotes(ctx, repo), remote), query);
  },
  // The core's create doesn't push: the branch is on the forge already (the UI pushed it), and an MR opens at that branch's tip.
  forgeCreateMr: async ({ repo, remote, req }, ctx) => {
    const f = await forgeOf(ctx, ctx.repos.get(repo).fs);
    const project = await projectForRemote(f, await forgeRemotes(ctx, repo), remote);
    const tip = await originTip(ctx, f, req.source.project, req.source.branch);
    const out = f.provider.createMr(project, req, tip);
    try {
      await describeNew(ctx, f, project.path, out.mr.number);
    } finally {
      wrote(f, project.path);
    }
    return out;
  },
  forgeCompleteCreate: async ({ repo, remote }, ctx) => {
    const f = await forgeOf(ctx, ctx.repos.get(repo).fs);
    await projectForRemote(f, await forgeRemotes(ctx, repo), remote);
    return f.provider.completeCreate();
  },
  // --- stacked MRs (the core's forge/stack.rs) ---
  forgeStack: async ({ repo, branches, base, baseRef }, ctx) => {
    const demo = ctx.repos.get(repo);
    const f = await forgeOf(ctx, demo.fs);
    return stackView(f, await forgeRemotes(ctx, repo), branches, base, await prefills(viewOf(demo), demo.path, branches, baseRef));
  },
  forgeSyncStack: async ({ repo, branches }, ctx) => syncStack(await forgeOf(ctx, ctx.repos.get(repo).fs), await forgeRemotes(ctx, repo), branches),
  forgeRetarget: async ({ repo, number, target: to }, ctx) => retargetMr(await forgeOf(ctx, ctx.repos.get(repo).fs), await forgeRemotes(ctx, repo), number, to, ctx),
};
