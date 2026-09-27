import { useEffect, useLayoutEffect, useRef } from 'react';
import { perf } from '../perf';
import { useDiffPrefs } from './diffPrefs';
import { EditorLoadError, useMonacoHost } from './TextDiff';

/** File View: the whole file at that commit, read-only and highlighted (spec §10.1). Attached
 * before it's shown, as `TextDiff` is. */
export function FileView({ path, text, language }: { path: string; text: string; language: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { host, error, retry } = useMonacoHost();
  const wordWrap = useDiffPrefs((s) => s.prefs.wordWrap);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!host || !el) return;
    host.attachFile(el);
    return () => host.detachFile(el);
  }, [host]);
  // Word wrap isn't a dependency: toggling it goes through the editor's options (below), so the
  // file isn't shown again and keeps its scroll position.
  useEffect(() => {
    if (host) void host.showFile({ path, text, language, wordWrap: useDiffPrefs.getState().prefs.wordWrap }).then(() => perf.done('diff'));
  }, [host, path, text, language]);
  useEffect(() => {
    host?.setFileWordWrap(wordWrap);
  }, [host, wordWrap]);
  if (error) return <EditorLoadError message={error} onRetry={retry} />;
  return <div ref={ref} className="text-diff" data-testid="file-view" />;
}
