import { useEffect, useLayoutEffect, useRef } from 'react';
import { useDiffPrefs } from './diffPrefs';
import type { MonacoHost } from './monaco/host';
import { EditorLoadError, keepWhileHidden, SHOW_ERROR_TITLE, useMonacoHost, useOnShown, useShow } from './TextDiff';

/** File View: the whole file at that commit, read-only and highlighted (spec §10.1). Attached
 * before it's shown, as `TextDiff` is; `onShown` as there. */
export function FileView({ path, text, language, onShown, editable = false, onEdit, identity }: { identity?: string; path: string; text: string; language: string; onShown?: () => void; editable?: boolean; onEdit?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { host, error, retry } = useMonacoHost();
  const wordWrap = useDiffPrefs((s) => s.prefs.wordWrap);
  const shown = useOnShown(onShown, error);
  // As TextDiff's: the shared editor hides another view's file until this one's is shown (H6).
  const content = useRef({ path, text });
  content.current = { path, text };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!host || !el) return;
    if (!host.keepFile(el, content.current)) host.attachFile(el, content.current);
    return keepWhileHidden(el, () => host.detachFile(el));
  }, [host]);
  // Word wrap isn't a dependency: toggling it goes through the editor's options (below), so the
  // file isn't shown again and keeps its scroll position.
  // As TextDiff's: a show starts read-only; the working-tree file is editable (spec #2 §7.5).
  const edit = useRef({ editable, onEdit });
  edit.current = { editable, onEdit };
  const applyEditable = (h: MonacoHost) => {
    h.setFileEditable(edit.current.editable);
    h.onFileEdit(edit.current.editable ? () => edit.current.onEdit?.() : null);
  };
  const show = useShow(host, async (h) => {
    await h.showFile({ identity, path, text, language, wordWrap: useDiffPrefs.getState().prefs.wordWrap });
    applyEditable(h);
  }, [path, text, language], shown);
  useEffect(() => {
    if (!host) return;
    applyEditable(host);
    return () => host.onFileEdit(null);
  }, [host, editable]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    host?.setFileWordWrap(wordWrap);
  }, [host, wordWrap]);
  if (error) return <EditorLoadError message={error} onRetry={retry} />;
  return (
    <>
      {show.failed && <EditorLoadError title={SHOW_ERROR_TITLE} message={show.failed} onRetry={show.retry} />}
      <div ref={ref} className="text-diff" data-testid="file-view" hidden={!!show.failed} />
    </>
  );
}
