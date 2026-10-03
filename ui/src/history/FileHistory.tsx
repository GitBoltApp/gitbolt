// Reached only through the center view's React.lazy (history/feature.ts): it pulls in File View,
// the Monaco loader and Shiki's language registry, which stay out of the startup chunk.
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { api } from '../api/client';
import type { FileHistoryRow } from '../api/gen/FileHistoryRow';
import type { DiffTarget } from '../repo/store';
import { selectCommit } from '../app/graphNav';
import { Avatar } from '../avatars/Avatar';
import { editorOwnsEscape, ESCAPE_OWNER_AREAS, useContents } from '../diff/DiffPanel';
import { FileView } from '../diff/FileView';
import { highlightLanguage } from '../diff/language';
import { relativeTime } from '../format/relative';
import { shortSha } from '../format/sha';
import { useCenterViewEditorFile, type CenterViewProps } from '../repo/centerView';
import { fileViewTarget, useRepoView } from '../repo/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { registerKeys } from '../ui/keyRouter';
import { isEditableTarget } from '../ui/keys';
import { useToast } from '../ui/toast';
import { BlameLayer } from './BlameGutter';
import { historyEnd, selectedRow, type FileHistoryArgs } from './model';
import { createHistoryStore, HISTORY_PAGE, type HistoryStore } from './store';
import './history.css';

/**
 * File History (spec #3 §4.2), in the graph's place: the file's commits on the left (newest
 * first, paged), the file at the selected commit on the right, read-only. × or Esc (from
 * anywhere in the tab, unless a text box or one of Monaco's own overlays has it) closes it.
 */
export function FileHistory({ tabId, props, close }: CenterViewProps<FileHistoryArgs>) {
  const [store] = useState(() => createHistoryStore(props, (skip) => api.fileHistory(props.repoId, props.worktree, props.path, props.rev, skip, HISTORY_PAGE)));
  const row = useStore(store, selectedRow);
  const ref = useRef<HTMLElement>(null);
  const blame = useStore(store, (s) => s.blame);
  // A right-click in the file: its menu (Copy path, the forge permalink, Open in…) is the selected
  // row's file at its commit, not the open file this view may hide.
  const shown = row && row.status !== 'D' ? row : null;
  const editorFile = useMemo(() => (shown ? { target: rowTarget(shown.path, shown.sha), root: props.worktree } : null), [shown, props.worktree]);
  useCenterViewEditorFile(tabId, editorFile);
  // Spec #3 §3.10: a blame group's commit opens in this list (pages load until it shows); Alt+click
  // selects it in the graph instead, which the view closes to show (ruling 5).
  const onPick = useCallback((sha: string, inGraph: boolean) => {
    if (inGraph) {
      close();
      if (!selectCommit(tabId, sha, { focus: true })) useToast.getState().show('Not in the loaded history');
      return;
    }
    void store.getState().seek(sha).then((found) => { if (!found) useToast.getState().show(`${shortSha(sha)} isn't in this file's history`); });
  }, [close, store, tabId]);
  useEffect(() => { void store.getState().loadMore(); }, [store]);
  useEffect(() => registerKeys('app', (e) => {
    if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing || e.defaultPrevented) return;
    if (ref.current?.checkVisibility?.() === false) return;
    const t = e.target instanceof Element ? e.target : null;
    if (isEditableTarget(t) && !t?.closest('.monaco-editor, .monaco-host')) return;
    if (e.composedPath().some((n) => n instanceof Element && n.matches(ESCAPE_OWNER_AREAS)) && editorOwnsEscape()) return;
    e.preventDefault();
    close();
    return 'handled';
  }), [close]);
  return (
    <section ref={ref} className="file-history" role="region" aria-label="File history">
      <header className="file-history-header">
        <HoverTooltip content={blame ? 'Hide who last changed each line' : 'Show who last changed each line'}>
          <button type="button" className="blame-toggle" aria-pressed={blame} onClick={() => store.getState().setBlame(!blame)}>Blame</button>
        </HoverTooltip>
        <h2 className="file-history-title">File History: <span className="file-history-path">{props.path}</span></h2>
        <HoverTooltip content="Close (Esc)">
          <button type="button" className="icon-button" aria-label="Close file history" onClick={close}><X size={14} /></button>
        </HoverTooltip>
      </header>
      <div className="file-history-body">
        <HistoryList store={store} path={props.path} />
        <div className="file-history-file">{row && <FileAtCommit row={row}>{blame && <BlameLayer repoId={props.repoId} worktree={props.worktree} row={row} onPick={onPick} />}</FileAtCommit>}</div>
      </div>
    </section>
  );
}

function HistoryList({ store, path }: { store: StoreApi<HistoryStore>; path: string }) {
  const s = useStore(store);
  const end = historyEnd(s);
  const listRef = useRef<HTMLUListElement>(null);
  // The keyboard moves in with the view: from the diff toolbar's History (whose mousedown keeps
  // focus in the file list, where ↓ would open the next file over the view), a menu or the
  // palette. Effects re-run when the view shows again (`<Activity>`), so a file peeked over it
  // closing hands the keyboard back here, not to the hidden graph.
  useEffect(() => listRef.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (s.selected) listRef.current?.querySelector<HTMLElement>(`[data-sha="${s.selected}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [s.selected]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    store.getState().step(e.key === 'ArrowDown' ? 1 : -1);
  };
  return (
    <div className="file-history-list">
      <ul ref={listRef} role="listbox" aria-label="Commits" tabIndex={0} onKeyDown={onKeyDown} aria-activedescendant={s.selected ? `fh-${s.selected}` : undefined}>
        {s.rows.map((r) => (
          <li key={r.sha} id={`fh-${r.sha}`} data-sha={r.sha} role="option" aria-selected={r.sha === s.selected} className="file-history-row" onClick={() => store.getState().select(r.sha)}>
            <Avatar name={r.author} email={r.email} size={20} />
            <span className="fh-summary">{r.summary}</span>
            <span className="fh-sha">{shortSha(r.sha)}</span>
            <span className="fh-meta">{relativeTime(r.time)} · {r.author}</span>
          </li>
        ))}
      </ul>
      {s.error && (
        <div role="alert" className="file-history-note">
          Couldn't load the history: {s.error} <button type="button" className="inline-retry" onClick={() => void store.getState().loadMore()}>Retry</button>
        </div>
      )}
      {s.more && !s.error && (
        <button type="button" className="file-history-more" disabled={s.loading} onClick={() => void store.getState().loadMore()}>{s.loading ? 'Loading…' : 'Load more'}</button>
      )}
      {end && (
        <div className="file-history-end">
          {s.rows.length === 0 && <div>No commit changed {path}</div>}
          {end.addedIn && <div>Added in {shortSha(end.addedIn)}</div>}
          <div>End of history</div>
        </div>
      )}
    </div>
  );
}

/** The file `path` at commit `sha`, as File View would open it. */
const rowTarget = (path: string, sha: string): DiffTarget => fileViewTarget(path, sha, { kind: 'commit', id: sha, parent: 0 });

/** The file at `row`'s commit, at that commit's path (a rename's old name below it). `children`
 * is laid over a shown text file (3A T5's blame gutter). */
export function FileAtCommit({ row, children }: { row: FileHistoryRow; children?: ReactNode }) {
  if (row.status === 'D') return <div className="diff-message"><p>{row.path} was deleted in this commit</p></div>;
  return <FileText row={row}>{children}</FileText>;
}

function FileText({ row, children }: { row: FileHistoryRow; children?: ReactNode }) {
  const services = useRepoView((s) => s.services);
  const target = useMemo(() => rowTarget(row.path, row.sha), [row.path, row.sha]);
  const [forced, setForced] = useState<string | null>(null);
  const contents = useContents(services, target, forced === target.key);
  const text = contents.status === 'ready' ? contents.data.new?.text ?? null : null;
  const language = useMemo(() => (text === null ? 'plaintext' : highlightLanguage(row.path, text)), [row.path, text]);
  if (contents.status === 'error') return <div className="diff-message"><div role="alert">Couldn't load {row.path}: {contents.message}</div></div>;
  if (contents.status !== 'ready') return <div className="diff-message" aria-busy="true" />;
  if (contents.data.tooLarge) {
    return (
      <div className="diff-message">
        <p>{row.path} is too large to show at once.</p>
        <button type="button" className="text-button" onClick={() => setForced(target.key)}>Load anyway</button>
      </div>
    );
  }
  if (text === null) return <div className="diff-message"><p>Binary file: there's no text to show</p></div>;
  return (
    <>
      <FileView identity={`history|${target.key}`} path={row.path} text={text} language={language} />
      {children}
    </>
  );
}
