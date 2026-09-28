import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { errorMessage } from '../api/client';
import { perf } from '../perf';
import { useDiffPrefs } from './diffPrefs';
import { setEditorRelease } from './editorRelease';
import type { MonacoHost } from './monaco/host';
import { loadMonacoHost } from './monaco/load';

// Once loaded, later mounts get the host on their first render (no empty frame per file).
let loaded: MonacoHost | null = null;

export interface MonacoHostState {
  /** Null while its lazy chunk (Monaco, Shiki, the WASM) loads, or after a failure. */
  host: MonacoHost | null;
  error: string | null;
  /** Loads again after a failure (`loadMonacoHost` forgets a rejected load). */
  retry(): void;
}

/** The shared Monaco host. */
export function useMonacoHost(): MonacoHostState {
  const [state, setState] = useState<{ host: MonacoHost | null; error: string | null }>({ host: loaded, error: null });
  const [attempt, setAttempt] = useState(0);
  const ready = state.host !== null;
  useEffect(() => {
    if (ready) return;
    let live = true;
    loadMonacoHost().then(
      (h) => {
        loaded = h;
        setEditorRelease(() => h.releaseDetached());
        if (live) setState({ host: h, error: null });
      },
      (e: unknown) => { if (live) setState({ host: null, error: errorMessage(e) }); },
    );
    return () => { live = false; };
  }, [ready, attempt]);
  return {
    ...state,
    retry: () => {
      setState({ host: null, error: null });
      setAttempt((n) => n + 1);
    },
  };
}

/** The editor's chunk failed to load (or, with `title`, showing a file in it failed): the
 * error, and a retry. */
export function EditorLoadError({ message, onRetry, title = "Couldn't load the editor" }: { message: string; onRetry: () => void; title?: string }) {
  return (
    <div className="diff-message">
      <div role="alert">{title}: {message}</div>
      <button type="button" className="inline-retry" onClick={onRetry}>Retry</button>
    </div>
  );
}

/** `onShown` for an editor view: called once its current content is on screen (or it failed to
 * load), never for content a newer render replaced. Kept in a ref, so a new callback each render
 * doesn't show the content again. */
export function useOnShown(onShown: (() => void) | undefined, error: string | null) {
  const latest = useRef(onShown);
  latest.current = onShown;
  useEffect(() => {
    // Out of the effect: the callback may flush a render (DiffPanel's `flushSync`).
    if (error) queueMicrotask(() => latest.current?.());
  }, [error]);
  return latest;
}

/**
 * Runs `show` on the host when `host` or any of `deps` changes, and again on `retry`. Once it
 * resolves, `onShown` (through `shown`) and the perf mark; if it rejects, `failed` holds the
 * message and `onShown` fires too, so the panel's header doesn't wait on a file that won't show.
 * A run a newer one replaced reports nothing.
 */
export function useShow(host: MonacoHost | null, show: (h: MonacoHost) => Promise<void>, deps: unknown[], shown: RefObject<(() => void) | undefined>) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const latest = useRef(show);
  latest.current = show;
  useEffect(() => {
    if (!host) return;
    let live = true;
    setFailed(null);
    latest.current(host).then(
      () => {
        perf.done('diff');
        if (live) shown.current?.();
      },
      (e: unknown) => {
        if (!live) return;
        setFailed(errorMessage(e));
        shown.current?.();
      },
    );
    return () => { live = false; };
  }, [host, attempt, shown, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { failed, retry: () => setAttempt((n) => n + 1) };
}

/**
 * The attach effect's cleanup (J16). A closed diff's panel is kept, hidden, by `<Activity>`, which
 * runs this cleanup too but leaves the box in the document: the editor stays in it, so showing the
 * panel again only `keep`s it. Unmounted while shown, the box is gone by the next microtask:
 * `detach`. Unmounted while hidden, this has already run (at the hide) and React doesn't run it
 * again, so nothing here detaches: the host lets that box go on the next attach elsewhere, and
 * the repo view's unmount calls `releaseDetachedEditors` (see `editorRelease.ts`).
 */
export const keepWhileHidden = (el: HTMLElement, detach: () => void) => () =>
  queueMicrotask(() => {
    if (!el.isConnected) detach();
  });

/** The error for a file the editor couldn't show, over the (hidden) editor. */
export const SHOW_ERROR_TITLE = "Couldn't show this file";

/**
 * A text diff in the app's one diff editor (spec §4.4). The editor is attached in a layout
 * effect, which runs before the passive effect that shows the texts: `showDiff` shows nothing
 * unless `attachDiff` has run. `onShown` fires once the diff is on screen (see `useOnShown`).
 */
export function TextDiff({ path, original, modified, language, onShown }: { path: string; original: string; modified: string; language: string; onShown?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { host, error, retry } = useMonacoHost();
  const prefs = useDiffPrefs((s) => s.prefs);
  const shown = useOnShown(onShown, error);
  // What this view will show, so the shared editor hides another view's diff it may still hold
  // (H6). Read at attach time only: later props go through `showDiff`, which swaps in place.
  const content = useRef({ path, original, modified });
  content.current = { path, original, modified };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!host || !el) return;
    if (!host.keepDiff(el, content.current)) host.attachDiff(el, content.current);
    return keepWhileHidden(el, () => host.detachDiff(el));
  }, [host]);
  const show = useShow(host, (h) => h.showDiff({ path, original, modified, language, prefs: useDiffPrefs.getState().prefs }), [path, original, modified, language], shown);
  useEffect(() => {
    host?.setDiffPrefs(prefs);
  }, [host, prefs]);
  if (error) return <EditorLoadError message={error} onRetry={retry} />;
  // The editor's box stays mounted (hidden) under a show error: the host's element lives in it.
  return (
    <>
      {show.failed && <EditorLoadError title={SHOW_ERROR_TITLE} message={show.failed} onRetry={show.retry} />}
      <div ref={ref} className="text-diff" data-testid="text-diff" hidden={!!show.failed} />
    </>
  );
}
