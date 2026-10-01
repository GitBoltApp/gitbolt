import type { HostKind } from '../api/gen/HostKind';
import type { LocalBranch } from '../api/gen/LocalBranch';
import type { RemoteBranch } from '../api/gen/RemoteBranch';
import type { SidebarPayload } from '../api/gen/SidebarPayload';
import type { SortMode } from '../api/gen/SortMode';
import type { StashItem } from '../api/gen/StashItem';
import type { TagItem } from '../api/gen/TagItem';
import type { WorktreeItem } from '../api/gen/WorktreeItem';

interface Base { key: string; name: string; target: string | null; time: number }
export type SideItem =
  | (Base & { kind: 'local'; branch: LocalBranch })
  | (Base & { kind: 'remote'; remote: string; branch: RemoteBranch })
  | (Base & { kind: 'worktree'; worktree: WorktreeItem })
  | (Base & { kind: 'stash'; stash: StashItem })
  | (Base & { kind: 'tag'; tag: TagItem });

export type SectionKind = 'local' | 'remote' | 'worktrees' | 'stashes' | 'tags';
export interface Section { id: string; kind: SectionKind; label: string; hostKind?: HostKind; items: SideItem[]; nests: boolean }

/** The sidebar's sections, in display order (spec §6.4): Local, each remote (in the payload's
 * order), Worktrees, Stashes, Tags. */
export function sectionsOf(p: SidebarPayload): Section[] {
  return [
    { id: 'local', kind: 'local', label: 'Local', nests: true, items: p.locals.map((b): SideItem => ({ key: b.fullName, kind: 'local', name: b.name, target: b.target, time: b.tipTime, branch: b })) },
    ...p.remotes.map((g): Section => ({
      id: `remote:${g.name}`, kind: 'remote', label: g.name, hostKind: g.hostKind, nests: true,
      items: g.branches.map((b): SideItem => ({ key: b.fullName, kind: 'remote', name: b.name, target: b.target, time: b.tipTime, remote: g.name, branch: b })),
    })),
    { id: 'worktrees', kind: 'worktrees', label: 'Worktrees', nests: false, items: p.worktrees.map((w): SideItem => ({ key: `wt:${w.path}`, kind: 'worktree', name: w.name, target: w.head, time: 0, worktree: w })) },
    { id: 'stashes', kind: 'stashes', label: 'Stashes', nests: false, items: p.stashes.map((s): SideItem => ({ key: `stash:${s.index}`, kind: 'stash', name: s.message, target: s.id, time: s.time, stash: s })) },
    { id: 'tags', kind: 'tags', label: 'Tags', nests: true, items: p.tags.map((t): SideItem => ({ key: t.fullName, kind: 'tag', name: t.name, target: t.target, time: t.time, tag: t })) },
  ];
}

export type FlatRow =
  | { type: 'section'; key: string; section: Section; collapsed: boolean; matched: number; total: number; sort: SortMode; filtering: boolean }
  | { type: 'folder'; key: string; name: string; depth: number; collapsed: boolean; section: Section }
  | { type: 'item'; key: string; item: SideItem; depth: number; label: string; section: Section };

export interface RowOptions { filter: string; sort: Record<string, SortMode | undefined>; collapsed: ReadonlySet<string> }

export const sectionKey = (id: string) => `section:${id}`;
export const folderKey = (sectionId: string, path: string) => `${sectionId}:${path}`;

interface Node { folders: Map<string, Node>; items: SideItem[] }
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/**
 * Flattens `sections` into the rows the sidebar renders (spec §6.4): a case-insensitive
 * substring filter over item names, keeping and forcing open the parent folders of any match
 * (section/folder counts show matched/total while filtering); `tree` sort (the default) nests
 * items by `/` in their name, folders first, both sorted case-insensitively; `recent` sort is
 * flat, newest `time` first. Only nesting sections (Local, each remote, Tags) sort — Worktrees
 * and Stashes always keep the payload's order. A collapsed section or folder (and anything
 * filtering doesn't force open) contributes no item/folder rows below it.
 */
export function buildRows(sections: Section[], o: RowOptions): FlatRow[] {
  const q = o.filter.trim().toLowerCase();
  const out: FlatRow[] = [];
  for (const s of sections) {
    const matched = q ? s.items.filter((i) => i.name.toLowerCase().includes(q)) : s.items;
    const sort: SortMode = s.nests ? o.sort[s.id] ?? 'tree' : 'tree';
    const collapsed = !q && o.collapsed.has(sectionKey(s.id));
    out.push({ type: 'section', key: sectionKey(s.id), section: s, collapsed, matched: matched.length, total: s.items.length, sort, filtering: !!q });
    if (collapsed) continue;
    const item = (it: SideItem, depth: number, label = it.name): FlatRow => ({ type: 'item', key: it.key, item: it, depth, label, section: s });
    if (!s.nests) {
      for (const it of matched) out.push(item(it, 1));
      continue;
    }
    if (sort === 'recent') {
      for (const it of [...matched].sort((a, b) => b.time - a.time || byName(a.name, b.name))) out.push(item(it, 1));
      continue;
    }
    const root: Node = { folders: new Map(), items: [] };
    for (const it of matched) {
      let n = root;
      for (const part of it.name.split('/').slice(0, -1)) {
        if (!n.folders.has(part)) n.folders.set(part, { folders: new Map(), items: [] });
        n = n.folders.get(part)!;
      }
      n.items.push(it);
    }
    const walk = (n: Node, depth: number, prefix: string) => {
      for (const [name, child] of [...n.folders].sort(([a], [b]) => byName(a, b))) {
        const path = prefix ? `${prefix}/${name}` : name;
        const key = folderKey(s.id, path);
        const fc = !q && o.collapsed.has(key);
        out.push({ type: 'folder', key, name, depth, collapsed: fc, section: s });
        if (!fc) walk(child, depth + 1, path);
      }
      for (const it of [...n.items].sort((a, b) => byName(a.name, b.name))) out.push(item(it, depth, it.name.split('/').pop()!));
    };
    walk(root, 1, '');
  }
  return out;
}
