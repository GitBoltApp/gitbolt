import { create } from 'zustand';

/**
 * A file or folder to show in a tab's file list, from outside it (a pasted path, `goto/run.ts`):
 * the list holding its row expands the folders above it (a folder: itself too), scrolls to it
 * and, for a folder, puts the cursor on it. The first list that has the row takes the request;
 * one no list takes soon is dropped (the selection moved on).
 */
export interface RevealRequest { tabId: string; path: string; folder: boolean; seq: number; at: number }

/** How long a request waits for a list to show its row (the tree of all files loading). */
export const REVEAL_WAIT_MS = 10_000;

export const useFileReveal = create<{ req: RevealRequest | null }>(() => ({ req: null }));

let seq = 0;
export function revealInFileList(tabId: string, path: string, folder: boolean): void {
  useFileReveal.setState({ req: { tabId, path, folder, seq: ++seq, at: Date.now() } });
}

/** The list showing the row took `req`: no other does. */
export function takeReveal(req: RevealRequest): void {
  if (useFileReveal.getState().req?.seq === req.seq) useFileReveal.setState({ req: null });
}
