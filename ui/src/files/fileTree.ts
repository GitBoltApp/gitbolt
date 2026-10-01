import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileChange } from '../api/gen/FileChange';
import { fileViewTarget, targetFor, type DiffTarget } from '../repo/store';
import { statusKind } from './StatusIcon';

export type FileListMode = 'path' | 'tree';
export type FileSort = 'path' | 'status';

/** "View all files"' filter (feedback K18): `query` (already trimmed and lowercased) is a
 * path substring, case-insensitive; empty matches everything. */
export const matchesFilter = (path: string, query: string) => query === '' || path.toLowerCase().includes(query);

/** Changed files per `StatusIcon` kind (`conflicted`: unmerged or unknown, U/X). */
export type StatusCounts = { modified: number; added: number; deleted: number; renamed: number; conflicted: number };

/** A tree row's horizontal layout, in px: `[chevron | status icon][gap][name]`, indented by
 * `rowIndent(depth)`. One level is exactly a chevron plus its gap, so a file's icon starts where
 * its folder's name does (feedback F17). */
export const TREE = { base: 8, chevron: 14, icon: 14, gap: 6 } as const;
export const rowIndent = (depth: number) => TREE.base + depth * (TREE.chevron + TREE.gap);

export type FileRow =
  /** `counts`: the subtree's changes, for a collapsed folder only (feedback F20). */
  | { kind: 'folder'; id: string; depth: number; name: string; path: string; expanded: boolean; counts: StatusCounts | null }
  | { kind: 'file'; id: string; depth: number; name: string; dir: string; change: FileChange | null; target: DiffTarget };

export interface TreeNode<T> { name: string; path: string; children: TreeNode<T>[]; item: T | null }

interface Item { path: string; change: FileChange | null; target: DiffTarget }

const STATUS_ORDER = 'AMTRCDUX';
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Folders first, then files, alphabetically. A folder whose only child is a folder merges into
 * one row (`src/Framework/Orm`, spec §9.3). */
export function buildTree<T extends { path: string }>(items: T[]): TreeNode<T>[] {
  const root: TreeNode<T> = { name: '', path: '', children: [], item: null };
  const folders = new Map<string, TreeNode<T>>([['', root]]);
  for (const it of items) {
    const parts = it.path.split('/');
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let folder = folders.get(path);
      if (!folder) {
        folder = { name: parts[i], path, children: [], item: null };
        folders.set(path, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    parent.children.push({ name: parts[parts.length - 1], path: it.path, children: [], item: it });
  }
  const finish = (n: TreeNode<T>): TreeNode<T> => {
    n.children = n.children.map(finish).sort((a, b) => ((a.item === null) === (b.item === null) ? cmp(a.name, b.name) : a.item === null ? -1 : 1));
    if (n.item === null && n.path !== '' && n.children.length === 1 && n.children[0].item === null) {
      const only = n.children[0];
      return { name: `${n.name}/${only.name}`, path: only.path, children: only.children, item: null };
    }
    return n;
  };
  return finish(root).children;
}

/** The visible rows of a tree: a collapsed folder's children are skipped. */
export function flattenTree<T>(nodes: TreeNode<T>[], collapsed: ReadonlySet<string>, depth = 0, out: { node: TreeNode<T>; depth: number }[] = []) {
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.item === null && !collapsed.has(n.path)) flattenTree(n.children, collapsed, depth + 1, out);
  }
  return out;
}

function items(files: FileChange[], spec: DiffSpec, unchanged: { commit: string; paths: string[] } | null): Item[] {
  const out: Item[] = files.map((f) => ({ path: f.path, change: f, target: targetFor(f, spec) }));
  if (unchanged) {
    const changed = new Set(files.map((f) => f.path));
    for (const p of unchanged.paths) if (!changed.has(p)) out.push({ path: p, change: null, target: fileViewTarget(p, unchanged.commit, spec) });
  }
  return out;
}

export interface RowsInput {
  files: FileChange[];
  spec: DiffSpec;
  /** "View all files": every path in `commit`'s tree; the ones not in `files` are unchanged. */
  unchanged: { commit: string; paths: string[] } | null;
  mode: FileListMode;
  sort: FileSort;
  collapsed: ReadonlySet<string>;
}

export function buildRows(i: RowsInput): FileRow[] {
  const all = items(i.files, i.spec, i.unchanged);
  if (i.mode === 'path') {
    const rank = (it: Item) => (it.change ? STATUS_ORDER.indexOf(it.change.status) : STATUS_ORDER.length);
    all.sort((a, b) => (i.sort === 'status' ? rank(a) - rank(b) : 0) || cmp(a.path, b.path));
    return all.map((it) => ({ kind: 'file', id: it.target.key, depth: 0, name: basename(it.path), dir: dirname(it.path), change: it.change, target: it.target }));
  }
  return flattenTree(buildTree(all), i.collapsed).map(({ node, depth }): FileRow => {
    if (node.item) return { kind: 'file', id: node.item.target.key, depth, name: node.name, dir: '', change: node.item.change, target: node.item.target };
    const expanded = !i.collapsed.has(node.path);
    return { kind: 'folder', id: `dir:${node.path}`, depth, name: node.name, path: node.path, expanded, counts: expanded ? null : countByStatus(subtreeChanges(node)) };
  });
}

/** The changed files under a folder (unchanged "View all files" entries don't count). */
function subtreeChanges(node: TreeNode<Item>, out: FileChange[] = []): FileChange[] {
  if (node.item?.change) out.push(node.item.change);
  for (const c of node.children) subtreeChanges(c, out);
  return out;
}

/** The changed files in display order (collapsed folders hide rows, not change their order). */
export function displayTargets(files: FileChange[], spec: DiffSpec, mode: FileListMode, sort: FileSort): DiffTarget[] {
  return buildRows({ files, spec, unchanged: null, mode, sort, collapsed: new Set() }).flatMap((r) => (r.kind === 'file' ? [r.target] : []));
}

/** Every folder row's path (for "Collapse all"). */
export function allFolderPaths(files: FileChange[], unchanged: { commit: string; paths: string[] } | null): string[] {
  return flattenTree(buildTree(files.map((f) => ({ path: f.path })).concat((unchanged?.paths ?? []).map((path) => ({ path })))), new Set())
    .filter(({ node }) => node.item === null)
    .map(({ node }) => node.path);
}

/** Header counts (spec §9.3), by `statusKind`: M and T are "modified", A and C "added", U and X
 * "conflicted". */
export function countByStatus(files: FileChange[]): StatusCounts {
  const c: StatusCounts = { modified: 0, added: 0, deleted: 0, renamed: 0, conflicted: 0 };
  for (const f of files) c[statusKind(f.status)]++;
  return c;
}
