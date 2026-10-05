import { lazy, Suspense, type ComponentType, type JSX } from 'react';
import { whenIdle } from './idle';
import { PlainBody } from './PlainBody';
import type { MarkdownProps } from './types';

type Impl = ComponentType<MarkdownProps>;

/** `<Markdown>` from the chunk `load` brings (spec §3.1): the plain text stands in while it
 * loads. Once it has loaded (`preload`, or an earlier mount), a first mount renders the body at
 * once: React.lazy reads a synchronous thenable without suspending. Exported for tests. */
export function lazyMarkdown(load: () => Promise<{ Markdown: Impl }>) {
  let loaded: Impl | null = null;
  let pending: Promise<Impl> | null = null;
  const fetch = () => (pending ??= load().then((m) => (loaded = m.Markdown), (e: unknown) => { pending = null; throw e; }));
  const Body = lazy(() => (loaded
    ? { then: (ok: (m: { default: Impl }) => void) => ok({ default: loaded! }) }
    : fetch().then((c) => ({ default: c }))) as Promise<{ default: Impl }>);
  function Markdown(props: MarkdownProps): JSX.Element {
    const cls = props.className ? `md ${props.className}` : 'md';
    return <Suspense fallback={<PlainBody text={props.text} className={cls} />}><Body {...props} /></Suspense>;
  }
  const preload = (): Promise<void> => fetch().then(() => undefined);
  let warming = false;
  /** Loads the chunk once the app is idle (once per session); returns its cancel. */
  function preloadWhenIdle(): () => void {
    if (warming || loaded) return () => {};
    warming = true;
    const cancel = whenIdle(() => { void preload().catch(() => { warming = false; }); }, IDLE_PRELOAD_MS);
    return () => {
      if (loaded || pending) return;
      cancel();
      warming = false;
    };
  }
  return { Markdown, preload, preloadWhenIdle };
}

/** The latest a startup preload waits for an idle moment. */
const IDLE_PRELOAD_MS = 3000;

const chunk = lazyMarkdown(() => import('./Markdown'));

/** Consumers import this one. */
export const Markdown = chunk.Markdown;

/** Loads the chunk, so later `<Markdown>` mounts render without the plain-text round (tests'
 * setup uses it). */
export const preloadMarkdown = chunk.preload;

/** The app warms the chunk when idle after the first repository tab shows: the first MR/PR view
 * or `.md` file renders at once, without a plain-text flash. Never part of startup itself. */
export const preloadMarkdownWhenIdle = chunk.preloadWhenIdle;
