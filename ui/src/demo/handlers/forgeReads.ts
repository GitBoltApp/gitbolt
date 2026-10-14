// The forge's read methods (the core's api.rs forge arms, forge/hub.rs and mrs.rs), on the demo's
// fake GitLab. A repository's forge is its target remote's project on gitlab.example.com.
import type { DemoContext } from '../context';
import { netOf } from '../engine/remote/network';
import { accounts, badgeRefs, cachedForks, branchMrs, cachedMrs, forgeOf, forgeRemotes, forksPage, fresh, mrList, mrTarget, projectForRemote, repoProjects, sameForks } from '../forge/hub';
import { freshen } from '../forge/gitEffects';
import { forgeMedia } from '../forge/media';
import type { HandlerTable } from '../transport';
import type { DemoRepo } from '../engine/repo';

/** api.rs: a failed read of the refs costs only the tips and the stack base, never the poll. */
const tipsOf = (demo: DemoRepo, refs: string[]) => badgeRefs(demo, refs).catch(() => ({ tips: new Map<string, string[]>(), stackBase: null }));

const forgeFor = async (ctx: DemoContext, repo: number) => {
  const demo = ctx.repos.get(repo);
  return { demo, f: await forgeOf(ctx, demo.fs), r: await forgeRemotes(ctx, repo) };
};

export const forgeReadHandlers: Pick<HandlerTable, 'forgeAccounts' | 'forgeRepoProjects' | 'forgeProjectSettings' | 'forgeForks' | 'forgeMrList' | 'forgeBranchMrs' | 'forgeCachedMrs' | 'forgeMrDetail' | 'forgeMrDiscussions' | 'forgeProjectByPath' | 'forgePeopleLimits' | 'forgeImage' | 'forgeVideo'> = {
  // The demo always has its one account, before any bundle has loaded too.
  forgeAccounts: async (_p, ctx) => accounts(await forgeOf(ctx, netOf(ctx).fs!)),
  forgeRepoProjects: async ({ repo }, ctx) => {
    const { f, r } = await forgeFor(ctx, repo);
    // A fork relationship this lookup learned (or saw change) moves the default trunk: the graph
    // refreshes once (api.rs).
    const before = cachedForks(f, r);
    const projects = await repoProjects(f, r);
    if (!sameForks(cachedForks(f, r), before)) ctx.emit({ type: 'refsUpdated', repo });
    return projects;
  },
  forgeProjectSettings: async ({ repo, remote }, ctx) => {
    const { f, r } = await forgeFor(ctx, repo);
    return f.provider.projectSettings(await projectForRemote(f, r, remote));
  },
  forgeForks: async ({ repo, remote, page, perPage }, ctx) => {
    const { f, r } = await forgeFor(ctx, repo);
    return forksPage(f, r, remote, page, perPage);
  },
  forgeMrList: async ({ repo, filter }, ctx) => {
    const { f, r } = await forgeFor(ctx, repo);
    return mrList(f, r, filter);
  },
  forgeBranchMrs: async ({ repo, refs }, ctx) => {
    const { demo, f, r } = await forgeFor(ctx, repo);
    return branchMrs(f, r, refs, await tipsOf(demo, refs));
  },
  forgeCachedMrs: async ({ repo, refs, filter }, ctx) => {
    const { demo, f, r } = await forgeFor(ctx, repo);
    return cachedMrs(f, r, refs, await tipsOf(demo, refs), filter);
  },
  forgeMrDetail: async ({ repo, number }, ctx) => {
    const { f, r } = await forgeFor(ctx, repo);
    const t = await mrTarget(f, r);
    await freshen(ctx, f, t.project.path, number);
    return fresh(f, f.provider.mrDetail(t.project, number));
  },
  forgeMrDiscussions: async ({ repo, number }, ctx) => {
    const { f, r } = await forgeFor(ctx, repo);
    const t = await mrTarget(f, r);
    await freshen(ctx, f, t.project.path, number);
    return fresh(f, f.provider.discussions(t.project, number));
  },
  forgeProjectByPath: async ({ repo, path }, ctx) => {
    const { f, r } = await forgeFor(ctx, repo);
    await mrTarget(f, r);
    return f.provider.project(path);
  },
  forgePeopleLimits: async ({ repo, remote }, ctx) => {
    const { f, r } = await forgeFor(ctx, repo);
    return f.provider.peopleLimits(await projectForRemote(f, r, remote));
  },
  forgeImage: ({ repo, url, userAllowed }, ctx) => forgeMedia(ctx, repo, url, userAllowed, false),
  forgeVideo: ({ repo, url, userAllowed }, ctx) => forgeMedia(ctx, repo, url, userAllowed, true),
};
