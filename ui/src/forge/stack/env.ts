import { useRuntime } from '../../app/runtime';
import { stackBase, stackFor, stacksOf, type Stack } from '../../stacks/detect';
import type { StackEnv } from './chain';
import { baseBranch } from './create';
import { branchMrs, forgeTarget } from './deps';

/** The tab's stack lookup, as `MenuEnv.stackOf` builds it, from the runtime's graph. */
export function stackOfTab(tabId: string): (branch: string) => Stack | null {
  const rt = useRuntime.getState().tabs[tabId];
  if (!rt?.graph) return () => null;
  const stacks = stacksOf(rt.graph, stackBase(rt.graph, rt.sidebar?.remotes ?? []));
  const head = rt.graph.head.branch?.replace(/^refs\/heads\//, '') ?? null;
  return (b) => stackFor(stacks, b, head);
}

/**
 * What `mrChain` and `afterMerge` read for tab `tabId`, built once per pass (one branch→MR map). `null`: the tab has no forge target yet.
 */
export function stackEnvOf(tabId: string): StackEnv | null {
  const target = forgeTarget(tabId);
  if (!target) return null;
  const rt = useRuntime.getState().tabs[tabId];
  const sb = rt?.sidebar;
  const graph = rt?.graph;
  const tips = new Map((sb?.locals ?? []).map((l) => [l.name, l.target]));
  const base = graph ? stackBase(graph, sb?.remotes ?? []) : null;
  return {
    mrOf: branchMrs(tabId),
    locals: new Set(tips.keys()),
    defaultBranch: target.project.defaultBranch ?? 'main',
    base: base ? baseBranch(base, target.remote) : null,
    stackOf: stackOfTab(tabId),
    tipOf: (b) => tips.get(b) ?? null,
  };
}

/** The operation in progress in the tab's active worktree (`MenuEnv.inProgress`). */
export function inProgressOf(tabId: string): string | null {
  const rt = useRuntime.getState().tabs[tabId];
  const wts = rt?.graph?.worktrees ?? [];
  const active = rt?.worktree ?? wts.find((w) => w.isMain)?.path ?? rt?.repo?.path;
  return wts.find((w) => w.path === active)?.inProgress ?? null;
}
