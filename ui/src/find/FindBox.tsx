import { ArrowDown, ArrowUp, History, LoaderCircle, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { TabSlotProps } from '../app/slots';
import { useRepoView, useRepoViewStore } from '../app/seams1b';
import { useAppState } from '../app/state';
import { formatDate } from '../format/date';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useKeys, type KeyHandler } from '../ui/keyRouter';
import { closeFind, rerunFind, revealOlder, searchOlder, setFindQuery, stepFind, useFind } from './findStore';
import './find.css';

const plain = (e: KeyboardEvent) => !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing;

/**
 * The find box (spec §8.7; the user's J5: "a little search box top-right edge of the graph/table
 * view"): over the graph panel's top-right corner (RepoView's graph overlay, so it hides with the
 * graph while a file is open, and its keys and effects stop then too). A match counter, ↑ ↓ ×, a
 * spinner while the path search runs, and "Search older history" for commits outside the window.
 *
 * Keys, through the key router's `overlay` layer while focus is inside the box (ahead of the
 * app's Esc, which would otherwise leave compare mode or close a file): Esc closes and clears,
 * Enter / ↓ go to the next match, Shift+Enter / ↑ to the previous one.
 */
export function FindBox({ tab }: TabSlotProps) {
  const dateFormat = useAppState((s) => s.settings.dateFormat);
  const tabId = tab.id;
  const s = useFind((st) => st.byTab[tabId]);
  const store = useRepoViewStore();
  const graph = useRepoView((v) => v.graph);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const open = !!s?.open;

  // Ctrl+F (and every Ctrl+F while open): the input takes the keyboard, its text selected.
  const focusRequest = s?.focusRequest ?? 0;
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    input.current?.select();
  }, [open, focusRequest]);

  // A new window (a refresh, a deeper load): the matches follow it; the selection stays.
  useEffect(() => void rerunFind(tabId), [tabId, graph]);

  const onKey: KeyHandler = (e) => {
    const t = e.target instanceof Node ? e.target : null;
    if (!t || !box.current?.contains(t) || !plain(e)) return;
    if (e.key === 'Escape' && !e.shiftKey) {
      closeFind(tabId);
      store.getState().setFocus('graph');
    } else if (t === input.current && (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      if (e.key === 'ArrowDown' && e.shiftKey) return;
      stepFind(tabId, e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 1);
    } else return;
    e.preventDefault();
    return 'handled';
  };
  useKeys('overlay', onKey, open);

  if (!s?.open) return null;
  const counter = s.matches.length ? `${s.index + 1} / ${s.matches.length}` : s.query.trim() ? '0 / 0' : '';
  const close = () => {
    closeFind(tabId);
    store.getState().setFocus('graph');
  };
  return (
    <div ref={box} className="find-box" role="search" aria-label="Find in graph">
      <div className="find-row">
        <input
          ref={input}
          type="text"
          aria-label="Find commits"
          placeholder="Message, SHA or path"
          spellCheck={false}
          autoComplete="off"
          value={s.query}
          onChange={(e) => void setFindQuery(tabId, e.target.value)}
        />
        {s.pathPending && <LoaderCircle size={13} className="find-spin" role="status" aria-label="Searching paths" />}
        <span className="find-count" aria-live="polite">{counter}</span>
        <HoverTooltip content="Previous match (Shift+Enter)">
          <button type="button" className="icon-button" aria-label="Previous match" disabled={!s.matches.length} onClick={() => stepFind(tabId, -1)}><ArrowUp size={13} /></button>
        </HoverTooltip>
        <HoverTooltip content="Next match (Enter)">
          <button type="button" className="icon-button" aria-label="Next match" disabled={!s.matches.length} onClick={() => stepFind(tabId, 1)}><ArrowDown size={13} /></button>
        </HoverTooltip>
        <HoverTooltip content="Close (Esc)">
          <button type="button" className="icon-button" aria-label="Close find" onClick={close}><X size={13} /></button>
        </HoverTooltip>
      </div>
      {s.message && <div className="find-message" role="status">{s.message}</div>}
      {s.query.trim() && (
        <div className="find-older">
          {s.older === null ? (
            <button type="button" className="find-older-btn" onClick={() => void searchOlder(tabId)} disabled={s.olderLoading}>
              <History size={12} /> {s.olderLoading ? 'Searching…' : 'Search older history'}
            </button>
          ) : s.older.length === 0 ? (
            <div className="find-dim">No older commits match.</div>
          ) : (
            <ul className="find-older-list" aria-label="Older commits">
              {s.older.map((h) => (
                <li key={h.id}>
                  <button type="button" className="find-older-row" onClick={() => void revealOlder(tabId, h.id)}>
                    <span className="find-sha">{h.id.slice(0, 6)}</span>
                    <span className="find-older-summary">{h.summary}</span>
                    <span className="find-dim">{h.author} · {formatDate(h.time, dateFormat)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
