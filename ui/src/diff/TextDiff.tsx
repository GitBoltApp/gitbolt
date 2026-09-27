import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { errorMessage } from '../api/client';
import { perf } from '../perf';
import { useDiffPrefs } from './diffPrefs';
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

/** The editor's chunk failed to load: the error, and a retry. */
export function EditorLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="diff-message">
      <div role="alert">Couldn't load the editor: {message}</div>
      <button type="button" className="inline-retry" onClick={onRetry}>Retry</button>
    </div>
  );
}

/**
 * A text diff in the app's one diff editor (spec §4.4). The editor is attached in a layout
 * effect, which runs before the passive effect that shows the texts: `showDiff` shows nothing
 * unless `attachDiff` has run.
 */
export function TextDiff({ path, original, modified, language }: { path: string; original: string; modified: string; language: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { host, error, retry } = useMonacoHost();
  const prefs = useDiffPrefs((s) => s.prefs);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!host || !el) return;
    host.attachDiff(el);
    return () => host.detachDiff(el);
  }, [host]);
  useEffect(() => {
    if (!host) return;
    void host.showDiff({ path, original, modified, language, prefs: useDiffPrefs.getState().prefs }).then(() => perf.done('diff'));
  }, [host, path, original, modified, language]);
  useEffect(() => {
    host?.setDiffPrefs(prefs);
  }, [host, prefs]);
  if (error) return <EditorLoadError message={error} onRetry={retry} />;
  return <div ref={ref} className="text-diff" data-testid="text-diff" />;
}
