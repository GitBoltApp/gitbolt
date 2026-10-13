// The graph (laid out by the core's own code, as WebAssembly) and the sidebar.
import type { HandlerTable } from '../transport';
import { buildSidebar } from '../engine/sidebar';
import { setFindWindow } from './find';

export const graphHandlers = {
  // `rescan` needs nothing: the demo reads each worktree's status every time.
  graph: async ({ repo, limit, pin, active }, ctx) => {
    const g = await ctx.repos.get(repo).graph({ limit, pin, active });
    // Find searches the commits this graph shows, as the core's FindSnapshot (plan 1b's find.ts).
    setFindWindow(ctx, repo, g.rows.filter((r) => r.kind !== 'wip').map((r) => r.id));
    return g;
  },
  sidebar: async ({ repo }, ctx) => buildSidebar(ctx.repos.get(repo)),
} satisfies Partial<HandlerTable>;
