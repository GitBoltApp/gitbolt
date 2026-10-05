import { tabView } from '../app/tabStores';
import { blobFor, IMAGE_MIME } from '../image/sources';
import type { FileCommit } from '../nav/history';
import { openFileAt } from '../nav/repoPlaces';
import { scrollToAnchorWhenReady } from '../nav/scroll';
import { contentKey } from '../repo/services';
import { openWorktree } from '../repo/store';
import { registerFileLinkHandler } from './actions';
import { registerRepoImageLoader } from './MdImage';
import type { FileMarkdownContext } from './types';

// 5B T6. Not in `fileContext.ts`: 5A's `links.ts` and `images.ts` import `resolveRepoPath` from
// there, so registering from that module would close an import cycle (actions → links →
// fileContext → actions) and run `registerFileLinkHandler` before `actions.ts` had initialized.
// Paths arrive repo-root-relative and already decoded (`resolveRepoPath`): never decode here.

/**
 * A relative link's plain click in File View (spec #5 §4.1): that file in File View at the same
 * commit, as a new navigation place, scrolled to its `#heading` if it has one; a missing file
 * says so ("<path> isn't in <sha>"). A link to this same file's heading scrolls the shown view.
 */
export function openFileLink(ctx: FileMarkdownContext, path: string, anchor: string | null): void {
  if (path === ctx.path) {
    const pane = [...document.querySelectorAll<HTMLElement>('.md-rendered')].find((el) => el.getClientRects().length > 0);
    if (anchor && pane) scrollToAnchorWhenReady(pane, anchor);
    return;
  }
  void openFileAt(ctx.tabId, path, ctx.commit, { record: true, anchor });
}

/** Object URLs of images at a commit (immutable), by key, least recently used first; past
 * MAX_URLS the oldest ones no `<img>` shows are revoked. */
const MAX_URLS = 64;
const urls = new Map<string, string>();
/** How many mounted images show each URL (`MdImage` gives each one back on unmount). */
const shown = new Map<string, number>();
/** A working-tree image's URL: read fresh each time, never looked up again. */
const once = new Set<string>();

function evict(): void {
  for (const [k, u] of urls) {
    if (urls.size <= MAX_URLS) break;
    if (shown.has(u)) continue;
    urls.delete(k);
    URL.revokeObjectURL(u);
  }
}

/** One more image shows `url`. */
function take(url: string): string {
  shown.set(url, (shown.get(url) ?? 0) + 1);
  return url;
}

/** An image no longer shows `url` (`MdImage`'s release): a working-tree one is revoked when none
 * does; a commit's waits in the cache. */
export function releaseRepoImage(url: string): void {
  const n = (shown.get(url) ?? 0) - 1;
  if (n > 0) { shown.set(url, n); return; }
  shown.delete(url);
  if (once.delete(url)) URL.revokeObjectURL(url);
  else evict();
}

/**
 * Spec #5 §4.2: a relative image in File View, read from the repository at that commit (or the
 * working tree) through the request the image diff uses, as an object URL. An SVG becomes an
 * `image/svg+xml` blob shown by `<img>`, never inlined. `null`: not an image, missing, or over
 * the size cap (the renderer shows the alt text). Images at a commit are read once; the working
 * tree's each time.
 */
export async function loadRepoImage(ctx: FileMarkdownContext, path: string, commit: FileCommit): Promise<string | null> {
  const mime = IMAGE_MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
  const v = tabView(ctx.tabId);
  if (!mime || !v) return null;
  const s = v.store.getState();
  const worktree = s.diff?.new.kind === 'worktree' ? s.diff.new.worktree : openWorktree(s);
  const key = contentKey({ path, old: { kind: 'absent' }, new: commit === 'worktree' ? { kind: 'worktree', worktree } : { kind: 'atCommit', commit }, force: false });
  const cacheKey = `${v.repo}|${key}`;
  const hit = commit === 'worktree' ? undefined : urls.get(cacheKey);
  if (hit) {
    // A hit is a use: it moves to the recent end.
    urls.delete(cacheKey);
    urls.set(cacheKey, hit);
    return take(hit);
  }
  try {
    const c = await v.services.contents.get(key);
    const blob = c.tooLarge ? null : blobFor(c.new, mime);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    if (commit === 'worktree') once.add(url);
    else {
      // Two images asked at once: the first answer is kept, the second goes.
      const raced = urls.get(cacheKey);
      if (raced) { URL.revokeObjectURL(url); return take(raced); }
      urls.set(cacheKey, url);
    }
    take(url);
    evict();
    return url;
  } catch {
    return null;
  }
}

const offLinks = registerFileLinkHandler(openFileLink);
const offImages = registerRepoImageLoader(loadRepoImage, releaseRepoImage);

import.meta.hot?.dispose(() => {
  offLinks();
  offImages();
});
