import type { CSSProperties } from 'react';
import { tabStore } from '../app/tabStores';
import { useTheme } from '../theme/store';
import { useRebaseSessions } from './session';

/** Each branch's lane colour index in tab `tabId`'s graph now (its tip row's): local branches by
 * their short name, remote ones as `origin/main`. Tags aren't branches. */
export function laneColors(tabId: string): Record<string, number> {
  const g = tabStore(tabId)?.getState().graph;
  const out: Record<string, number> = {};
  if (!g) return out;
  for (const l of g.labels) {
    const c = g.rows[l.row]?.color;
    if (l.tag || c === undefined) continue;
    if (l.local) out[l.local.replace(/^refs\/heads\//, '')] ??= c;
    for (const r of l.remotes) out[r.fullName.replace(/^refs\/remotes\//, '')] ??= c;
  }
  return out;
}

/** A chip's colour (R1.8): its branch's graph lane colour when the editor opened, in the current
 * theme; `undefined`: the default chip colour (a branch not in the graph, or added here). */
export function useChipColor(tabId: string): (branch: string) => string | undefined {
  const colors = useRebaseSessions((x) => x.sessions[tabId]?.colors);
  const lanes = useTheme((s) => s.colors.graph);
  return (branch) => {
    const c = colors?.[branch];
    return c === undefined || lanes.length === 0 ? undefined : lanes[c % lanes.length];
  };
}

/** The style that gives a chip its lane colour (`--chip-lane`, editor.css). */
export const laneStyle = (color: string | undefined): CSSProperties | undefined => (color ? { ['--chip-lane' as string]: color } : undefined);
