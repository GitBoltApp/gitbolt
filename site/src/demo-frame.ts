// The hero's live demo (website spec §3, §4.5, §6.3): the demo build (demo/demo.html) in an iframe
// over the hero's still screenshot. It starts after the page has loaded and gone idle, and only
// where its frame can be 960 px wide (a 992 px viewport, less the gutters); the still stays until
// the demo reports its graph is up (ui/src/demo/frame.ts), and stays if the demo can't start.

export const DEMO_SRC = 'demo/demo.html';
export const WIDE_ENOUGH = '(min-width: 992px)';
export const READY_TIMEOUT_MS = 90_000;
export type DemoState = 'still' | 'loading' | 'ready' | 'failed';

const BADGE: Record<DemoState, string> = {
  still: 'Screenshot',
  loading: 'Loading the live demo…',
  ready: 'Live demo',
  failed: "The live demo didn't start",
};

export interface WideQuery { readonly matches: boolean; addEventListener(type: 'change', listener: () => void): void }
export interface HeroDemoOptions {
  src: string;
  origin: string;
  timeoutMs: number;
  wide: WideQuery;
  /** Calls `start` once the page has loaded and the browser is idle. */
  schedule(start: () => void): void;
  /** Where the demo's messages arrive. */
  messages: Pick<Window, 'addEventListener'>;
}
export interface HeroDemo { readonly state: DemoState; readonly frame: HTMLIFrameElement | null; reset(): void }

/** The demo's report, if `e` is one, from `frame`, on `origin`. */
export function demoReport(e: MessageEvent, frame: HTMLIFrameElement | null, origin: string): { type: 'ready' } | { type: 'failed'; message: string } | null {
  if (!frame || e.source !== frame.contentWindow || e.origin !== origin) return null;
  const d = e.data as { source?: unknown; type?: unknown; message?: unknown } | null;
  if (typeof d !== 'object' || d === null || d.source !== 'gitbolt-demo') return null;
  if (d.type === 'ready') return { type: 'ready' };
  if (d.type === 'failed') return { type: 'failed', message: typeof d.message === 'string' ? d.message : '' };
  return null;
}

/** After the load event, when the browser is idle: the demo's code and data never compete with the page's own. */
export function afterLoadAndIdle(win: Window, run: () => void): void {
  const idle = () => {
    if (typeof win.requestIdleCallback === 'function') win.requestIdleCallback(() => run(), { timeout: 2000 });
    else win.setTimeout(run, 200);
  };
  if (win.document.readyState === 'complete') idle();
  else win.addEventListener('load', idle, { once: true });
}

export function initHeroDemo(root: HTMLElement, options: Partial<HeroDemoOptions> = {}): HeroDemo {
  const src = options.src ?? DEMO_SRC;
  const origin = options.origin ?? location.origin;
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
  const wide = options.wide ?? matchMedia(WIDE_ENOUGH);
  const schedule = options.schedule ?? ((start: () => void) => afterLoadAndIdle(window, start));
  const messages = options.messages ?? window;
  const stage = root.querySelector<HTMLElement>('.stage');
  const badge = root.querySelector<HTMLElement>('.demo-badge');
  if (!stage || !badge) throw new Error('the hero has no .stage or .demo-badge');

  let frame: HTMLIFrameElement | null = null;
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  let detail = '';
  // Below the wide breakpoint the still shows whatever the demo is doing, so the badge says so.
  const label = () => {
    const state = root.dataset.state as DemoState;
    if (!wide.matches && state !== 'failed') return BADGE.still;
    return detail ? `${BADGE[state]}: ${detail}` : BADGE[state];
  };
  const show = (state: DemoState, why = '') => {
    root.dataset.state = state;
    detail = why;
    badge.textContent = label();
    badge.title = badge.textContent;
  };
  const start = () => {
    scheduled = true;
    clearTimeout(timer);
    frame?.remove();
    frame = root.ownerDocument.createElement('iframe');
    frame.className = 'demo-live';
    frame.title = 'GitBolt live demo';
    frame.src = src;
    stage.append(frame);
    show('loading');
    timer = setTimeout(() => {
      if (root.dataset.state === 'loading') show('failed', 'it took too long to load');
    }, timeoutMs);
  };
  messages.addEventListener('message', (e) => {
    const report = demoReport(e, frame, origin);
    if (!report) return;
    clearTimeout(timer);
    if (report.type === 'ready') show('ready');
    else show('failed', report.message);
  });
  const startWhenWide = () => {
    if (!wide.matches || frame || scheduled) return;
    scheduled = true;
    schedule(() => { if (!frame) start(); });
  };
  show('still');
  startWhenWide();
  wide.addEventListener('change', () => {
    badge.textContent = label();
    badge.title = badge.textContent;
    startWhenWide();
  });

  return {
    get state() { return root.dataset.state as DemoState; },
    get frame() { return frame; },
    reset: start,
  };
}

/** Full screen for the demo's window (Esc leaves it, as the browser does); hidden where the browser has none. */
export function initFullscreen(
  button: HTMLButtonElement,
  target: HTMLElement,
  doc: Pick<Document, 'fullscreenEnabled' | 'fullscreenElement' | 'exitFullscreen' | 'addEventListener'>,
  focusTarget: () => HTMLElement | null,
): void {
  if (!doc.fullscreenEnabled) {
    button.hidden = true;
    return;
  }
  button.addEventListener('click', () => {
    if (doc.fullscreenElement === target) void doc.exitFullscreen();
    else void target.requestFullscreen().then(() => focusTarget()?.focus(), () => undefined);
  });
  doc.addEventListener('fullscreenchange', () => {
    button.textContent = doc.fullscreenElement === target ? 'Exit full screen' : 'Full screen';
  });
}
