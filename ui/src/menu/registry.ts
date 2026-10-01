import type { MenuRow } from './types';

export type MenuKind = 'commit' | 'tag' | 'file' | 'folder' | 'monaco' | 'tab' | 'column';

/** Group order per menu. `commit` (branch label / commit) follows spec §7's target table. */
export const GROUP_ORDER: Record<MenuKind, readonly string[]> = {
  commit: ['sync', 'integrate', 'branch', 'commit', 'forge', 'manage', 'copy', 'view'],
  // Ruling (fix round 1, item 5): spec §7 wins over 1B's own order here — Copy name, then Forge
  // link.
  tag: ['copy', 'forge', 'view'],
  file: ['copy', 'forge', 'open', 'view'],
  folder: ['copy', 'open'],
  monaco: ['copy', 'forge', 'open'],
  tab: ['edit', 'close', 'restore', 'repo'],
  column: ['columns'],
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
