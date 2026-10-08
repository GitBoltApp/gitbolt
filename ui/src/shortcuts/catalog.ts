import { allActions, type ActionGroup } from '../app/actions';
import { keyHints } from './hints';

export interface ShortcutRow { id: string; label: string; keys: string[]; context?: string }
export interface ShortcutSection { title: string; rows: ShortcutRow[] }

const ACTION_SECTIONS: Record<ActionGroup, string> = {
  File: 'Repo actions', Edit: 'Edit and search', View: 'Navigation', Repository: 'Repo actions', Help: 'Help',
};
const ORDER = ['Repo actions', 'Navigation', 'Edit and search', 'Staging', 'Commit message', 'Diff', 'File history', 'Merge request', 'Rebase editor', 'Help'];

export { keycaps } from '../ui/platformKeys';

/** Every real binding: the actions with a shortcut (usable now or not: the panel is the reference,
 * so "Stage file" is listed with no file open) plus the declared hints, grouped by section. Built
 * from the live registries, not a hand-written list. */
export function shortcutSections(): ShortcutSection[] {
  const by = new Map<string, ShortcutRow[]>();
  const add = (section: string, row: ShortcutRow) => by.set(section, [...(by.get(section) ?? []), row]);
  const seen = new Set<string>();
  for (const a of allActions()) {
    if (!a.shortcuts?.length) continue;
    const key = `${a.label}|${a.shortcuts.join()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    add(a.section ?? ACTION_SECTIONS[a.group], { id: a.id, label: a.label, keys: a.shortcuts });
  }
  for (const h of keyHints()) add(h.section, { id: h.id, label: h.label, keys: h.keys, context: h.context });
  const rank = (t: string) => (ORDER.includes(t) ? ORDER.indexOf(t) : ORDER.length);
  return [...by.entries()].sort((x, y) => rank(x[0]) - rank(y[0]) || x[0].localeCompare(y[0])).map(([title, rows]) => ({ title, rows }));
}

/** Rows whose section, label, context or keys contain every word of `q`. */
export function filterSections(all: ShortcutSection[], q: string): ShortcutSection[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return all;
  return all
    .map((s) => ({ title: s.title, rows: s.rows.filter((r) => {
      const hay = `${s.title} ${r.label} ${r.context ?? ''} ${r.keys.join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }) }))
    .filter((s) => s.rows.length);
}
