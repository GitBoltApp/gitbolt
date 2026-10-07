import { api, errorMessage } from '../api/client';
import { tabStore } from '../app/tabStores';
import { forgeOf, knownMr } from '../forge/mrStore';
import { loadMrDetail, openMrView } from '../forge/poll';
// --- 5B T6 ---
import { recordPlace } from '../nav/history';
import { scrollToAnchorWhenReady } from '../nav/scroll';
// --- end 5B T6 ---
import { useToast } from '../ui/toastStore';
import { browserUrlFor } from './links';
import type { FileMarkdownContext, LinkTarget, MarkdownContext } from './types';

export type FileLinkHandler = (ctx: FileMarkdownContext, path: string, anchor: string | null) => void;
let fileLinkHandler: FileLinkHandler | null = null;

/** 5B's File View opens relative links: `path` is already repo-root-relative (`resolveRepoPath`). Returns its removal. */
export function registerFileLinkHandler(fn: FileLinkHandler): () => void {
  fileLinkHandler = fn;
  return () => { if (fileLinkHandler === fn) fileLinkHandler = null; };
}
export const hasFileLinkHandler = (): boolean => fileLinkHandler !== null;

export function openExternal(url: string): void {
  api.openUrl(url).catch((e: unknown) => useToast.getState().show(errorMessage(e), { error: true }));
}

/** GitHub's `#n` is a PR or an issue: the view when the PR exists, else the browser. */
async function openMr(tabId: string, target: Extract<LinkTarget, { kind: 'mr' }>): Promise<void> {
  const f = forgeOf(tabId);
  if (f.kind !== 'github' || knownMr(f, target.number) || f.details[target.number]) {
    openMrView(tabId, target.number);
    return;
  }
  await loadMrDetail(tabId, target.number, 0);
  if (forgeOf(tabId).details[target.number]) openMrView(tabId, target.number);
  else openExternal(target.webUrl);
}

/** The pane a document scrolls in: File View's rendered view, the flyout's body, else the nearest
 * ancestor that scrolls. */
function scrollPane(root: Element): HTMLElement | null {
  const known = root.closest<HTMLElement>('.md-rendered, .flyout-body');
  if (known) return known;
  for (let el = root.parentElement; el; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}

/** Scrolls to `id` inside the document `origin` is in (an `<a name>` is a target too: GitHub's
 * README anchors). Only that document's pane scrolls (the flyout or File View), never the app
 * window, and a target in a chunk still rendering is waited for. */
function scrollToAnchor(id: string, origin?: Element): void {
  const root = origin?.closest('.md');
  const pane = root ? scrollPane(root) : null;
  if (root && pane) scrollToAnchorWhenReady(pane, id, root);
}

/** A plain click on a link or reference (spec §4.1). Nothing here navigates the app's window. */
export async function openLinkTarget(ctx: MarkdownContext, target: LinkTarget, origin?: Element): Promise<void> {
  switch (target.kind) {
    case 'mr':
      return openMr(ctx.tabId, target);
    case 'commit': {
      const store = tabStore(ctx.tabId);
      if (store?.getState().indexById.has(target.sha)) {
        // --- 5B T6: a SHA-link jump is a navigation place (spec #5 §3.4), recorded before the jump so
        // the view being left saves its scroll; a commit that isn't loaded opens on the forge instead ---
        recordPlace(ctx.tabId, { kind: 'commit', sha: target.sha });
        // --- end 5B T6 ---
        // Loaded on use: the menu env pulls in most of the app, which the Markdown chunk needn't.
        const { fileMenuEnv } = await import('../menu/menuEnv');
        fileMenuEnv(store).act.showInGraph(target.sha);
      } else if (target.webUrl) openExternal(target.webUrl);
      return;
    }
    case 'anchor':
      scrollToAnchor(target.id, origin);
      return;
    case 'external':
      openExternal(target.url);
      return;
    case 'file': {
      if (ctx.kind === 'file') { fileLinkHandler?.(ctx, target.path, target.anchor); return; }
      const url = browserUrlFor(ctx, target);
      if (url) openExternal(url);
      return;
    }
    case 'inert':
      return;
  }
}
