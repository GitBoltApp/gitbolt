import { LoaderCircle } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { activeTab } from '../app/actions';
import { isTopModal, useModalKeys } from '../app/modalKeys';
import { registerKeys } from '../ui/keyRouter';
import { actionEntries, fileEntries, refEntries, settingEntries, tabEntries } from './sources';
import { GROUP_LABEL, parseQuery, searchPalette, type PaletteEntry } from './search';
import './palette.css';

export const usePalette = create<{ open: boolean; initial: string; show(prefix?: string): void; close(): void }>((set) => ({
  open: false,
  initial: '',
  show: (prefix = '') => set({ open: true, initial: prefix }),
  close: () => set({ open: false, initial: '' }),
}));

export function Palette() {
  const open = usePalette((s) => s.open);
  return open ? <PaletteDialog /> : null;
}

function PaletteDialog() {
  const initial = usePalette((s) => s.initial);
  const close = usePalette((s) => s.close);
  const [query, setQuery] = useState(initial);
  const [cursor, setCursor] = useState(0);
  const [files, setFiles] = useState<PaletteEntry[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tab = activeTab();
  const tabId = tab?.kind === 'repo' ? tab.id : null;
  // Sources are read once on open: the palette is modal, so nothing changes under it.
  const base = useMemo(() => [...actionEntries(), ...(tabId ? refEntries(tabId) : []), ...settingEntries(), ...tabEntries()], [tabId]);
  useEffect(() => {
    let live = true;
    if (tabId) void fileEntries(tabId).then((f) => { if (live) setFiles(f); });
    else setFiles([]);
    return () => { live = false; };
  }, [tabId]);
  // One stable array per (base, files): its targets are prepared once, not per keystroke.
  const all = useMemo(() => (files ? [...base, ...files] : base), [base, files]);
  const deferred = useDeferredValue(query);
  const results = useMemo(() => searchPalette(deferred, all), [deferred, all]);
  // The highlight restarts whenever the results change (typing, or the file list arriving).
  useEffect(() => { setCursor(0); }, [results]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [cursor]);
  const run = (entry: PaletteEntry | undefined) => { if (!entry) return; close(); entry.run(); };

  // The dialog claims every key in the router's `menu` layer (Esc, Tab trap), so the input's own
  // onKeyDown never sees one; the list keys come through a second handler in the same layer.
  const ref = useModalKeys<HTMLDivElement>(true, close);
  const live = useRef({ results, cursor, run, query, deferred, all });
  live.current = { results, cursor, run, query, deferred, all };
  useEffect(() => registerKeys('menu', (e) => {
    if (!isTopModal(ref)) return; // a prompt over the palette owns Enter and the arrows
    const { results: rs, cursor: c, run: go, query: q, deferred: d, all: entries } = live.current;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing) return;
    if (e.key === 'ArrowDown') setCursor(Math.min(rs.length - 1, c + 1));
    else if (e.key === 'ArrowUp') setCursor(Math.max(0, c - 1));
    // The shown results can lag the input (`useDeferredValue` on a busy main thread): Enter then
    // answers the query as typed, its best match (the cursor restarts at the top for new results).
    else if (e.key === 'Enter') go(q === d ? rs[c] : searchPalette(q, entries)[0]);
    else return;
    e.preventDefault();
    return 'handled';
  }), [ref]);

  const wantsFiles = parseQuery(query).group === 'file' || parseQuery(query).group === null;
  return (
    <div className="modal-backdrop palette-backdrop" onPointerDown={close}>
      <div ref={ref} className="palette" role="dialog" aria-label="Command palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          aria-label="Command palette query"
          placeholder="Type to search · > actions · @ branches · / files · # settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div ref={listRef} className="palette-list" role="listbox" aria-label="Results">
          {results.map((r, i) => (
            <div key={r.id}>
              {(i === 0 || results[i - 1].group !== r.group) && <div className="palette-group" role="presentation">{GROUP_LABEL[r.group]}</div>}
              <div role="option" aria-selected={i === cursor} className="palette-item" onPointerEnter={() => setCursor(i)} onClick={() => run(r)}>
                <span className="palette-label">{r.label}</span>
                {r.detail && <span className="palette-detail">{r.detail}</span>}
              </div>
            </div>
          ))}
          {files === null && wantsFiles && <div className="palette-loading"><LoaderCircle size={12} className="spin" /> Loading files…</div>}
          {results.length === 0 && files !== null && <div className="palette-empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}
