import { flushSync } from 'react-dom';
import { create } from 'zustand';
import { api } from '../api/client';
import type { Hunk } from '../api/gen/Hunk';
import type { HunksPayload } from '../api/gen/HunksPayload';
import type { DiffTarget } from '../repo/store';
import type { HunkZoneRequest } from './monaco/host';

/** A WIP diff's side, from its key (`filesKey(spec)|path`); `null` for any other diff. */
export function wipSideOf(t: Pick<DiffTarget, 'key' | 'path'>): { worktree: string; staged: boolean } | null {
  try {
    const spec = JSON.parse(t.key.slice(0, t.key.length - t.path.length - 1)) as { kind: string; worktree?: string; staged?: boolean };
    return spec.kind === 'wip' && typeof spec.worktree === 'string' ? { worktree: spec.worktree, staged: !!spec.staged } : null;
  } catch {
    return null;
  }
}

/** A hunk's header row's place: above its first line, or after the line a pure insertion or
 * deletion sits at (an empty range is numbered by the line before it). */
export const zoneAfter = (start: number, lines: number) => (lines === 0 ? start : Math.max(0, start - 1));

/** git's header for a hunk, `@@ -a,b +c,d @@`. */
export const hunkHeader = (h: Hunk) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;

/** The hunks the shown WIP diff was laid out with (§7.3), and its header rows' DOM nodes (Hunk
 * mode; `[]` otherwise). One editor shows one diff at a time, so there's one of these. */
export interface ShownHunks { repoId: number; key: string; payload: HunksPayload | null; nodes: HTMLElement[] }
export const useShownHunks = create<{ shown: ShownHunks | null }>(() => ({ shown: null }));

/** Usable hunks: none for a binary file or one git refuses to stage by hunk. */
export const hunksOf = (p: HunksPayload | null): Hunk[] => (p && !p.binary && p.refused === null ? p.hunks : []);

/**
 * The open WIP file's hunks from the backend (§7.3), read for each show of its diff and handed to
 * the editor with it (`HunkZoneRequest`): the header rows are laid out in the frame the diff
 * appears in, and their buttons are rendered before that frame paints. A stage, a discard, a save
 * or the watcher changes the diff's texts, which shows it again, and so reads them again.
 */
export function wipHunkZones(repoId: number, target: Pick<DiffTarget, 'key' | 'path'>): HunkZoneRequest | undefined {
  const side = wipSideOf(target);
  if (!side) return undefined;
  let payload: HunksPayload | null = null;
  const zones = api.wipHunks(repoId, side.worktree, target.path, side.staged).then(
    (p) => {
      payload = p;
      return hunksOf(p).map((h) => ({ after: zoneAfter(h.newStart, h.newLines) }));
    },
    () => [],
  );
  return {
    zones,
    // A microtask: still before the frame paints, and never inside a React lifecycle (a mode
    // change lays the rows out from an effect).
    placed: (nodes) => queueMicrotask(() => flushSync(() => useShownHunks.setState({ shown: { repoId, key: target.key, payload, nodes } }))),
  };
}
