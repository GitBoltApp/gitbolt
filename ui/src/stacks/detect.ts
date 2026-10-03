// ui/src/stacks/detect.ts
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';

/**
 * A stack (spec #3 §3.11): local branches B1 → … → Bn, each tip an ancestor of the next on its
 * first-parent line, B1 ahead of `base`. Pure data from the graph, so #4's forge stacks can reuse
 * it.
 */
export interface Stack {
  /** Short names, bottom (next to the base) → top. Two or more. */
  branches: string[];
  /** The full ref it sits on: `refs/remotes/origin/main`, or `refs/heads/main`. */
  base: string;
  /** Local branches built on a member that aren't on this straight path (another line off a
   * fork): a stack rebase leaves them on the old commits. */
  leftBehind: string[];
  /** The loaded graph cuts through this stack: a member's tip is beyond the loaded rows, so the
   * path can't be trusted until more history is loaded. */
  partial?: boolean;
}

type Graph = Pick<GraphPayload, 'rows' | 'labels'>;

const HEADS = 'refs/heads/';
const TRUNKS = ['main', 'master', 'trunk'];

/** The base's row, and its branch name (`main` for `origin/main`), from its label. */
export function findBase(labels: readonly RefLabel[], base: string): { row: number; name: string } | null {
  for (const l of labels) {
    if (l.local === base) return { row: l.row, name: base.slice(HEADS.length) };
    const r = l.remotes.find((x) => x.fullName === base);
    if (r) return { row: l.row, name: base.slice(`refs/remotes/${r.remote}/`.length) };
  }
  return null;
}

/**
 * Every stack on `base` in the loaded graph: one per straight path (a fork gives one per line),
 * newest top first. O(rows + labels): rows come children before parents (core walk.rs), so one
 * pass marks the base's ancestry and one reverse pass finds each row's nearest member below it.
 *
 * - Members are local branches whose tip isn't in the base's history; a branch named like the
 *   base's own branch (`main` for `origin/main`) never is one (Ruling 4).
 * - A member's parent is the nearest member down its first-parent line, before the base's
 *   history; branches on one commit chain by name (Ruling 3).
 * - A tree with a single member isn't a stack.
 */
export function detectStacks(graph: Graph, base: string): Stack[] {
  const { rows, labels } = graph;
  const found = findBase(labels, base);
  if (!found) return [];
  const n = rows.length;
  const index = new Map<string, number>();
  for (let i = 0; i < n; i++) index.set(rows[i].id, i);
  const inBase = new Uint8Array(n);
  inBase[found.row] = 1;
  for (let i = found.row; i < n; i++) {
    if (!inBase[i]) continue;
    for (const p of rows[i].parents) {
      const j = index.get(p);
      if (j !== undefined) inBase[j] = 1;
    }
  }
  const onRow = new Map<number, string[]>();
  const rowOf = new Map<string, number>();
  for (const l of labels) {
    if (l.tag || !l.local?.startsWith(HEADS)) continue;
    const name = l.local.slice(HEADS.length);
    if (!rows[l.row] || inBase[l.row] || name === found.name || rowOf.has(name)) continue;
    rowOf.set(name, l.row);
    const list = onRow.get(l.row);
    if (list) list.push(name);
    else onRow.set(l.row, [name]);
  }
  for (const list of onRow.values()) list.sort();
  // below[i]: the nearest member strictly below row i on its first-parent line (a parent's row
  // index is always greater, so it's computed first).
  const below: (string | null)[] = new Array(n).fill(null);
  for (let i = n - 1; i >= 0; i--) {
    const p = rows[i].parents[0];
    const j = p === undefined ? undefined : index.get(p);
    if (j === undefined || inBase[j]) continue;
    const there = onRow.get(j);
    below[i] = there ? there[there.length - 1] : below[j];
  }
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const [row, list] of onRow) {
    list.forEach((name, k) => {
      const parent = k > 0 ? list[k - 1] : below[row];
      if (parent === null) roots.push(name);
      else {
        const c = children.get(parent);
        if (c) c.push(name);
        else children.set(parent, [name]);
      }
    });
  }
  const newestFirst = (a: string, b: string) => rowOf.get(a)! - rowOf.get(b)! || (a < b ? -1 : a > b ? 1 : 0);
  for (const c of children.values()) c.sort(newestFirst);
  const stacks: Stack[] = [];
  const walk = (name: string, path: string[]): void => {
    const next = [...path, name];
    const kids = children.get(name) ?? [];
    if (kids.length === 0) {
      if (next.length >= 2) stacks.push({ branches: next, base, leftBehind: [] });
      return;
    }
    for (const k of kids) walk(k, next);
  };
  for (const r of roots.sort(newestFirst)) walk(r, []);
  const subtree = (name: string, out: string[]): void => {
    out.push(name);
    for (const k of children.get(name) ?? []) subtree(k, out);
  };
  for (const s of stacks) {
    const on = new Set(s.branches);
    for (const m of s.branches) for (const k of children.get(m) ?? []) if (!on.has(k)) subtree(k, s.leftBehind);
  }
  // The bottom member's line runs off the loaded rows without reaching the base's history.
  const cut = (name: string) => {
    const p = rows[rowOf.get(name)!].parents[0];
    return p !== undefined && !index.has(p);
  };
  for (const s of stacks) if (s.branches.some(cut)) s.partial = true;
  const top = (s: Stack) => s.branches[s.branches.length - 1];
  return stacks.sort((a, b) => newestFirst(top(a), top(b)));
}

/** The stack a branch's menu acts on: the straight path through it; at or below a fork, the
 * one topped by the checked-out branch, else the newest top's (`detectStacks` lists those first). `null`: not stacked. */
export function stackFor(stacks: readonly Stack[], branch: string, headBranch: string | null = null): Stack | null {
  const through = stacks.filter((s) => s.branches.includes(branch));
  return through.find((s) => s.branches[s.branches.length - 1] === headBranch) ?? through[0] ?? null;
}

/** A remote as `stackBase` needs it (the sidebar's `RemoteGroup` fits). */
export interface BaseRemote { name: string; defaultBranch?: string | null }

/**
 * The stack base (spec #3 §3.11), among the refs the graph has loaded: a remote's default branch
 * (`refs/remotes/<r>/HEAD`), origin first; else `<remote>/main|master|trunk`; else a local
 * main/master/trunk. Remote names also come from the graph's labels, for before the sidebar loads.
 */
export function stackBase(graph: Pick<GraphPayload, 'labels'>, remotes: readonly BaseRemote[]): string | null {
  const present = new Set<string>();
  const names = new Set(remotes.map((r) => r.name));
  for (const l of graph.labels) {
    if (l.local) present.add(l.local);
    for (const r of l.remotes) {
      present.add(r.fullName);
      names.add(r.remote);
    }
  }
  const ordered = [...names].sort((a, b) => Number(a !== 'origin') - Number(b !== 'origin') || (a < b ? -1 : a > b ? 1 : 0));
  for (const name of ordered) {
    const d = remotes.find((r) => r.name === name)?.defaultBranch;
    if (d && present.has(d)) return d;
  }
  for (const name of ordered) for (const b of TRUNKS) if (present.has(`refs/remotes/${name}/${b}`)) return `refs/remotes/${name}/${b}`;
  for (const b of TRUNKS) if (present.has(`${HEADS}${b}`)) return `${HEADS}${b}`;
  return null;
}

const cache = new WeakMap<readonly RowPayload[], { labels: readonly RefLabel[]; base: string; stacks: Stack[] }>();

/** `detectStacks`, once per graph payload and base: a menu opens on it synchronously. */
export function stacksOf(graph: Graph, base: string | null): Stack[] {
  if (!base) return [];
  const hit = cache.get(graph.rows);
  if (hit && hit.labels === graph.labels && hit.base === base) return hit.stacks;
  const stacks = detectStacks(graph, base);
  cache.set(graph.rows, { labels: graph.labels, base, stacks });
  return stacks;
}
