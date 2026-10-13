import { useLayoutEffect } from 'react';
import { create } from 'zustand';

/**
 * Why a shown CSV or TSV body isn't a table (a note: it's Source instead), or null when it is,
 * by the body's identity (its target key). The body works it out from the text it shows (unsaved
 * edits included) and publishes it here; the toolbar reads it, so the two never disagree.
 */
export const useTableStatus = create<{ notes: Record<string, string | null> }>(() => ({ notes: {} }));

/** Publishes `note` for `key` while the body is mounted; `undefined`: nothing to say (Source was
 * picked, or it isn't a table). */
export function usePublishTableStatus(key: string, note: string | null | undefined): void {
  useLayoutEffect(() => {
    if (note === undefined) return;
    useTableStatus.setState((s) => ({ notes: { ...s.notes, [key]: note } }));
    return () => useTableStatus.setState((s) => {
      const notes = { ...s.notes };
      delete notes[key];
      return { notes };
    });
  }, [key, note]);
}
