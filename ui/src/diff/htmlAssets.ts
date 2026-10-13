import { useEffect, useState } from 'react';
import { tabView } from '../app/tabStores';
import type { BlobPayload } from '../api/gen/BlobPayload';
import { IMAGE_MIME } from '../image/sources';
import { resolveRepoPath } from '../markdown/fileContext';
import type { FileCommit } from '../nav/history';
import { contentKey } from '../repo/services';
import { openWorktree } from '../repo/store';
import type { InlinedAssets, Page, PageAssets } from './pageDoc';

/** Where an HTML page's relative files are read from: its repository tab, the commit (or the
 * working tree) shown, and the page's own path. */
export interface PageSource { tabId: string; commit: FileCommit; path: string }

/** At most this many relative files are inlined per page, and this many bytes of them in all (as
 * `data:` URLs and CSS text): the rest are left out, and the bar says so. */
export const MAX_PAGE_ASSETS = 32;
export const MAX_PAGE_ASSET_BYTES = 8 * 1024 * 1024;
/** Files read at once. */
const BATCH = 4;

/** A side's bytes as a `data:` URL for `<img>`. */
export function imageDataUrl(b: BlobPayload | null, mime: string): string | null {
  if (!b) return null;
  if (b.base64 !== null) return `data:${mime};base64,${b.base64}`;
  if (b.text !== null && mime === IMAGE_MIME.svg) return `data:${mime};charset=utf-8,${encodeURIComponent(b.text)}`;
  return null;
}

/** One repository file's contents (the diff contents request, so it's cached as File View's
 * are); `null` when it's missing, too large or can't be read. */
async function readFile(src: PageSource, path: string): Promise<BlobPayload | null> {
  const v = tabView(src.tabId);
  if (!v) return null;
  const s = v.store.getState();
  const worktree = s.diff?.new.kind === 'worktree' ? s.diff.new.worktree : openWorktree(s);
  const key = contentKey({ path, old: { kind: 'absent' }, new: src.commit === 'worktree' ? { kind: 'worktree', worktree } : { kind: 'atCommit', commit: src.commit }, force: false });
  try {
    const c = await v.services.contents.get(key);
    return c.tooLarge ? null : c.new;
  } catch {
    return null;
  }
}

/** One relative file's inlined form: a stylesheet's text, an image's `data:` URL; `null` when it
 * can't be (missing, not an image, too large to read). */
async function inlineOne(src: PageSource, ref: string, css: boolean): Promise<string | null> {
  const path = resolveRepoPath(src.path, ref.split('#')[0]);
  if (!path) return null;
  if (css) return (await readFile(src, path))?.text ?? null;
  const mime = IMAGE_MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
  return mime ? imageDataUrl(await readFile(src, path), mime) : null;
}

/** The page's relative images and stylesheets (stylesheets first), read from the repository at
 * the page's commit a few at a time, until `MAX_PAGE_ASSETS` or `MAX_PAGE_ASSET_BYTES`: the
 * rest are `omitted`. */
export async function loadPageAssets({ images, styles }: PageAssets, src: PageSource): Promise<InlinedAssets> {
  const out = { images: new Map<string, string>(), styles: new Map<string, string>(), omitted: 0 };
  const wanted = [...styles.map((ref) => ({ ref, css: true })), ...images.map((ref) => ({ ref, css: false }))];
  let bytes = 0;
  let i = 0;
  for (; i < Math.min(wanted.length, MAX_PAGE_ASSETS); i += BATCH) {
    const batch = wanted.slice(i, Math.min(i + BATCH, MAX_PAGE_ASSETS));
    const read = await Promise.all(batch.map(({ ref, css }) => inlineOne(src, ref, css)));
    let full = false;
    batch.forEach(({ ref, css }, j) => {
      const v = read[j];
      if (v === null) return;
      if (full || bytes + v.length > MAX_PAGE_ASSET_BYTES) { full = true; out.omitted++; return; }
      bytes += v.length;
      (css ? out.styles : out.images).set(ref, v);
    });
    if (full) { i += BATCH; break; }
  }
  out.omitted += Math.max(0, wanted.length - Math.min(i, wanted.length));
  return out;
}

const NONE: InlinedAssets = { images: new Map(), styles: new Map() };

/** `page`'s inlined files once they've loaded (`null` before); none, at once, without a `page`
 * or a `src`, or when it uses no relative files. */
export function usePageAssets(page: Page | null, src: PageSource | null): InlinedAssets | null {
  const tabId = src?.tabId;
  const commit = src?.commit;
  const path = src?.path;
  const wanted = page?.assets ?? null;
  const wants = !!wanted && wanted.images.length + wanted.styles.length > 0;
  const [state, setState] = useState<{ key: unknown[]; assets: InlinedAssets } | null>(null);
  useEffect(() => {
    if (!wants || !wanted || tabId === undefined || commit === undefined || path === undefined) return;
    let live = true;
    const key = [wanted, tabId, commit, path];
    void loadPageAssets(wanted, { tabId, commit, path }).then((assets) => { if (live) setState({ key, assets }); });
    return () => { live = false; };
  }, [wants, wanted, tabId, commit, path]);
  if (!src || !wants) return NONE;
  const key = [wanted, tabId, commit, path];
  return state !== null && state.key.every((k, i) => k === key[i]) ? state.assets : null;
}
