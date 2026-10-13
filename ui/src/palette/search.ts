import fuzzysort from 'fuzzysort';

/** `choice`: the entries of a picker an action opened (`usePalette.choose`), alone. */
export type PaletteGroup = 'action' | 'ref' | 'file' | 'setting' | 'tab' | 'choice';
export interface PaletteEntry { id: string; group: PaletteGroup; label: string; detail?: string; run(): void; /** Shift+Enter: an @ ref's checkout. */ alt?(): void }

export const GROUP_ORDER: readonly PaletteGroup[] = ['action', 'ref', 'file', 'setting', 'tab', 'choice'];
export const GROUP_LABEL: Record<PaletteGroup, string> = { action: 'Actions', ref: 'Branches & tags', file: 'Files at HEAD', setting: 'Settings', tab: 'Tabs & recent repos', choice: 'Choose' };
const PREFIX: Record<string, PaletteGroup> = { '>': 'action', '@': 'ref', '/': 'file', '#': 'setting' };

export function parseQuery(q: string): { group: PaletteGroup | null; text: string } {
  const group = PREFIX[q.charAt(0)] ?? null;
  return { group, text: (group ? q.slice(1) : q).trim() };
}

type Prepared = ReturnType<typeof fuzzysort.prepare>;

/** Entries grouped and prepared once per entries array (identity), not on every keystroke: with
 * tens of thousands of files, preparing each target per `go` call is what makes typing stutter. */
const grouped = new WeakMap<PaletteEntry[], Map<PaletteGroup, PaletteEntry[]>>();
const prepared = new WeakMap<PaletteEntry, Prepared>();
export const preparedCount = { n: 0 };

function groupsOf(entries: PaletteEntry[]): Map<PaletteGroup, PaletteEntry[]> {
  let g = grouped.get(entries);
  if (g) return g;
  g = new Map(GROUP_ORDER.map((k) => [k, []]));
  for (const e of entries) {
    g.get(e.group)!.push(e);
    if (!prepared.has(e)) {
      prepared.set(e, fuzzysort.prepare(e.label));
      preparedCount.n++;
    }
  }
  grouped.set(entries, g);
  return g;
}

/** Spec §11.2: fuzzy search, ranked by group, then score. Pass the same `entries` array while it
 * is unchanged, so its targets stay prepared. */
export function searchPalette(query: string, entries: PaletteEntry[], perGroup = 8): PaletteEntry[] {
  const { group, text } = parseQuery(query);
  const limit = group ? 50 : perGroup;
  const g = groupsOf(entries);
  return GROUP_ORDER.filter((k) => !group || k === group).flatMap((k) => {
    const list = g.get(k)!;
    if (!text) return list.slice(0, limit);
    return fuzzysort.go(text, list, { key: (e: PaletteEntry) => prepared.get(e), limit, threshold: 0.3 }).map((r) => r.obj);
  });
}

/** A picker's entries (`usePalette.choose`) matching `query`, best first, every match (the
 * palette shows the first ones and counts the rest). No group prefixes: `>` or `/` is text. */
export function searchChoices(query: string, entries: PaletteEntry[]): PaletteEntry[] {
  const text = query.trim();
  if (!text) return entries;
  groupsOf(entries);
  return fuzzysort.go(text, entries, { key: (e: PaletteEntry) => prepared.get(e), threshold: 0.3 }).map((r) => r.obj);
}
