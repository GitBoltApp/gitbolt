// The demo inside the website's page (site/src/demo-frame.ts): tells the page when the app is up
// (its commit graph is on screen) or why it couldn't start, so the page swaps its still screenshot
// for the live frame. Only to its own origin's parent; nothing when demo.html isn't framed.
import { asGbError } from './engine/errors';

export const DEMO_MESSAGE = 'gitvolt-demo';
export type DemoStatus = { source: typeof DEMO_MESSAGE; type: 'ready' } | { source: typeof DEMO_MESSAGE; type: 'failed'; message: string };

export function reportToParent(win: Window, boot: Promise<unknown>, graphShown: () => Promise<void>): void {
  if (win.parent === win) return;
  const post = (status: DemoStatus) => win.parent.postMessage(status, win.location.origin);
  boot.then(graphShown).then(
    () => post({ source: DEMO_MESSAGE, type: 'ready' }),
    (e: unknown) => post({ source: DEMO_MESSAGE, type: 'failed', message: asGbError(e).message }),
  );
}

/** Resolves once `doc` shows the commit graph. */
export function whenGraphShown(doc: Document): Promise<void> {
  const shown = () => doc.querySelector('[role="grid"][aria-label="Commit graph"]') !== null;
  if (shown()) return Promise.resolve();
  return new Promise((resolve) => {
    const watch = new MutationObserver(() => {
      if (!shown()) return;
      watch.disconnect();
      resolve();
    });
    watch.observe(doc.documentElement, { childList: true, subtree: true });
  });
}
