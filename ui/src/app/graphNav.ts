import { tabStore } from './tabStores';

/**
 * Selects `sha` in the tab's graph, as a click would (the details panel follows, an open diff
 * closes), and the graph scrolls it into view. `focus` also moves the keyboard to the graph (the
 * sidebar's Enter, spec §11.1). False if the commit isn't in the loaded rows (or the tab has no
 * graph yet): the caller may load a deeper window first.
 */
export function selectCommit(tabId: string, sha: string, opts: { focus?: boolean } = {}): boolean {
  const s = tabStore(tabId)?.getState();
  if (!s?.selectCommitById(sha)) return false;
  if (opts.focus) s.setFocus('graph');
  return true;
}
