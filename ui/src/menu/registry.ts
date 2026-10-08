import type { MenuRow } from './types';

export type MenuKind = 'commit' | 'tag' | 'file' | 'folder' | 'monaco' | 'tab' | 'tabbar' | 'column' | 'sidebar' | 'wip' | 'selection' | 'chip' | 'mr' | 'link';

/** Group order per menu. `commit` (branch label / commit) follows spec §7's target table. */
export const GROUP_ORDER: Record<MenuKind, readonly string[]> = {
  commit: ['sync', 'integrate', 'branch', 'commit', 'stash', 'forge', 'manage', 'copy', 'view'],
  // Spec #3 §4.3: the tag's Push (3B) and Delete (3B), then 1B's rows. Ruling (fix round 1, item
  // 5): spec §7 wins over 1B's own order here — Copy name, then Forge link.
  tag: ['sync', 'manage', 'copy', 'forge', 'view'],
  // 3A: 'restore' (from a commit) after the WIP groups, 'history' (File history, Blame) last.
  file: ['stage', 'conflict', 'restore', 'copy', 'forge', 'open', 'view', 'history'],
  folder: ['copy', 'open'],
  monaco: ['copy', 'forge', 'open'],
  tab: ['edit', 'group', 'close', 'restore', 'repo'],
  // The tab bar's empty space: Reopen closed tab and Saved groups, then Open repository / Clone.
  tabbar: ['restore', 'open'],
  column: ['columns'],
  // The sidebar's own items (remote, worktree, stash): 2C's worktree and stash rows first (spec
  // #2 §10, §11), then the read-only rows and "Show in graph" (plan 1C Task 15b). A remote's
  // "Push all tags" (3B) comes first.
  // A remote's "Remove remote…" ends its menu ('manage').
  sidebar: ['sync', 'worktree', 'stash', 'copy', 'forge', 'open', 'view', 'manage'],
  // A WIP row (spec #2 §14): Switch to this worktree, Open in a new tab, then Stash.
  wip: ['worktree', 'stash'],
  // Two or more selected commits (spec #3 §4.3): 3C's Squash, 3B's Cherry-pick and Revert,
  // 3C's "Interactive rebase from here".
  selection: ['squash', 'commit', 'rebase'],
  // A branch chip in the interactive rebase editor (UX R1.3): Delete branch, Restore, then Copy.
  chip: ['manage', 'copy'],
  // A sidebar MR/PR row: Open, Check out (here or in a new worktree), Show in graph, the copies
  // and the link, then the author's draft ⇄ ready.
  mr: ['open', 'checkout', 'view', 'copy', 'forge'],
  // --- 5A T6: a link in rendered Markdown (spec #5 §4.1): Open in GitBolt / in browser, then the copies ---
  link: ['open', 'copy'],
  // --- end 5A T6 ---
};

export interface MenuContribution<T, E> {
  /** Unique, e.g. 'copy.branchName'. */
  id: string;
  kind: MenuKind;
  /** One of GROUP_ORDER[kind]; unknown groups sort last. */
  group: string;
  /** Position inside the group. */
  order: number;
  /** Capability gate (e.g. forge configured, not WIP); omitted = always. */
  when?: (target: T, env: E) => boolean;
  /** Zero or more rows, each with its icon and tooltip; [] = not applicable. */
  rows: (target: T, env: E) => MenuRow[];
}

type AnyContribution = MenuContribution<unknown, unknown>;
const contributions = new Map<string, AnyContribution>();

/** The dev server re-runs an edited module (HMR), registering its contributions again. */
const hotReloading = () => import.meta.env.DEV && import.meta.env.MODE !== 'test';

/**
 * Adds rows to a menu. Call it from the module that ships the feature (spec §3: no row before its
 * sub-project ships), at import time. Returns an unregister function (tests). A second
 * registration of an id throws (two features claiming one row), except on the dev server, where
 * a hot-reloaded module's registration replaces its previous one.
 */
export function registerMenu<T, E>(c: MenuContribution<T, E>): () => void {
  if (contributions.has(c.id) && !hotReloading()) throw new Error(`menu contribution ${c.id} is already registered`);
  contributions.set(c.id, c as AnyContribution);
  return () => { if (contributions.get(c.id) === c) contributions.delete(c.id); };
}

/** Rows for `kind`: groups in GROUP_ORDER, a separator between non-empty groups. Pure and sync. */
export function buildMenu<T, E>(kind: MenuKind, target: T, env: E): MenuRow[] {
  const order = GROUP_ORDER[kind];
  const rank = (g: string) => { const i = order.indexOf(g); return i < 0 ? order.length : i; };
  const mine = [...contributions.values()].filter((c) => c.kind === kind).sort((a, b) => rank(a.group) - rank(b.group) || a.order - b.order);
  const out: MenuRow[] = [];
  let group: string | null = null;
  for (const c of mine) {
    if (c.when && !c.when(target, env)) continue;
    const rows = c.rows(target, env);
    if (rows.length === 0) continue;
    if (group !== null && group !== c.group) out.push({ kind: 'separator' });
    group = c.group;
    out.push(...rows);
  }
  return out;
}

/** Label template: `{X}` = the HEAD branch, `{Y}` = the clicked branch (spec §7 examples). */
export function tmpl(label: string, vars: { X?: string | null; Y?: string | null }): string {
  return label.replaceAll('{X}', vars.X || 'HEAD').replaceAll('{Y}', vars.Y || 'this branch');
}
