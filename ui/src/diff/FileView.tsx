import { useEffect, useLayoutEffect, useRef } from 'react';
import { useRepoContext } from '../app/repoContext';
import { registerScrollSource, takePendingScroll } from '../nav/scroll';
import { useDiffPrefs } from './diffPrefs';
import type { MonacoHost } from './monaco/host';
import { EditorLoadError, keepWhileHidden, SHOW_ERROR_TITLE, useMonacoHost, useOnShown, useShow } from './TextDiff';

/** File View: the whole file at that commit, read-only and highlighted (spec §10.1). Attached
 * before it's shown, as `TextDiff` is; `onShown` as there. */
export function FileView({ path, text, language, onShown, editable = false, onEdit, identity, navKey = null }: { identity?: string; path: string; text: string; language: string; onShown?: () => void; editable?: boolean; onEdit?: () => void; /** Spec #5 §3.4: the navigation place shown (`filePlaceKey`). */ navKey?: string | null }) {
  const { tabId } = useRepoContext();
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
    // Back/Forward to this file: the line it was scrolled to (spec #5 §3.4).
    const back = navKey ? takePendingScroll(tabId, 'file', navKey, 'source') : null;
    if (back) h.setFileScrollTop(back.top);
  }, [path, text, language], shown);
  // This place's scroll, read from the editor (it keeps it while hidden under the rendered view).
  useEffect(() => (host && navKey ? registerScrollSource(tabId, 'file', navKey, () => host.fileScrollTop()) : undefined), [host, tabId, navKey]);
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
