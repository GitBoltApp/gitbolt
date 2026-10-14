// The graph (laid out by the core's own code, as WebAssembly) and the sidebar.
import type { HandlerTable } from '../transport';
import { buildSidebar } from '../engine/sidebar';
import { cachedForks, forgeOf, forgeRemotes } from '../forge/hub';
import { setFindWindow } from './find';

export const graphHandlers = {
  // `rescan` needs nothing: the demo reads each worktree's status every time.
  graph: async ({ repo, limit, pin, active }, ctx) => {
    const demo = ctx.repos.get(repo);
    // The default trunk follows the root of the remotes' forks: the forge's cached facts only.
    const forks = cachedForks(await forgeOf(ctx, demo.fs), await forgeRemotes(ctx, repo));
    const g = await demo.graph({ limit, pin, active, forks });
    // Find searches the commits this graph shows, as the core's FindSnapshot (plan 1b's find.ts).
    setFindWindow(ctx, repo, g.rows.filter((r) => r.kind !== 'wip').map((r) => r.id));
    return g;
  },
  sidebar: async ({ repo }, ctx) => buildSidebar(ctx.repos.get(repo)),
} satisfies Partial<HandlerTable>;
