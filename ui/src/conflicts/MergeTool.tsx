// Reached only through repo/LazyDiffPanel.tsx's lazy import: the editors pull in Monaco.
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { copyText } from '../api/transport';
import type { ConflictFilePayload } from '../api/gen/ConflictFilePayload';
import { useRepoContext } from '../app/repoContext';
import { comboOf } from '../app/shortcuts';
import { DiffHeader, editorOwnsEscape, ESCAPE_OWNER_AREAS } from '../diff/DiffPanel';
import { highlightLanguage } from '../diff/language';
import { installLeaveGuard, installWindowCloseGuard } from '../diff/workingCopy';
import { useEscapeOwner } from '../repo/escape';
import { useFocusZone } from '../repo/focus';
import { useRepoView, useRepoViewStore, type DiffTarget } from '../repo/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useKeys } from '../ui/keyRouter';
import { ERROR_TOAST_MS, useToast } from '../ui/toast';
import type { WriteCtx } from '../write/client';
import { writeCtx } from '../write/ctx';
import { createMergeEditors, type MergeEditors } from './editors';
import { dropDraft, draftKey, getDraft, isPristine, patchDraft, putDraft, registerLive, sameSegments, saveMerge } from './mergeDrafts';
import { emptyPicks, nextRegion, regionLines, sideHasLines, sideState, takeAll, toggleHunk, toggleLine, type ConflictSegment, type Picks, type Side } from './model';
import { NonTextConflict } from './NonTextConflict';
import './mergeTool.css';

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);
const toast = (m: string) => useToast.getState().show(m, { ms: ERROR_TOAST_MS });
/** How long after the last keystroke the output is written into the draft. */
const PERSIST_MS = 300;

type Loaded = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; file: ConflictFilePayload | null };

/**
 * §13.3's merge tool: Current | Incoming side by side, the output below.
 * - The panes show each side's whole file, its regions tinted, with a checkbox per region (a view
 *   zone above it) and per conflicting line (the glyph margin; Space on the pane's cursor line);
 *   a header checkbox takes a side everywhere.
 * - A tick rebuilds only its region in the output (an undoable edit that takes the ticks back
 *   too); hand edits elsewhere stay.
 * - The work (ticks and output) is kept per (tab, path) in `mergeDrafts`, across a hidden tab,
 *   another file and a reload; leaving it unsaved asks (2B T11's guards).
 * - Ctrl+S or the button saves and marks the file resolved (`saveMerge`). F7 / Shift+F7 and the
 *   arrows step the regions.
 * - A conflict that isn't text on both sides gets the buttons instead (`NonTextConflict`).
 */
export function MergeTool({ ctx, path, onResolved }: { ctx: WriteCtx; path: string; onResolved?: () => void }) {
  const key = draftKey(ctx.tabId, ctx.worktree, path);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [picks, setPicksState] = useState<Picks>({});
  const [saving, setSaving] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [cursor, setCursor] = useState(1);
  // The picks as of the last tick, for the editors' callbacks (which outlive a render).
  const picksRef = useRef<Picks>({});
  const currentEl = useRef<HTMLDivElement>(null);
  const incomingEl = useRef<HTMLDivElement>(null);
  const outputEl = useRef<HTMLDivElement>(null);
  const eds = useRef<MergeEditors | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /** What was fetched (key and reload): a hidden tab shown again keeps it, no refetch. */
  const fetched = useRef('');
  /** A reset is under way: the editors going away mustn't write into the draft. */
  const resetting = useRef(false);
  const inFlight = useRef(false);
  /** Resolved: nothing is kept any more (the guards mustn't find work in a closing tool). */
  const done = useRef(false);
  const [, rendered] = useState(0);
  const file = loaded.status === 'ready' ? loaded.file : null;
  const textual = !!file?.text && !!file.current && !!file.incoming;

  useEffect(() => {
    const id = `${key}|${reloads}`;
    if (fetched.current === id) return;
    let live = true;
    setLoaded({ status: 'loading' });
    api.conflictFile(ctx.repoId, ctx.worktree, path).then(
      (f) => {
        if (!live) return;
        fetched.current = id;
        let p = f ? emptyPicks(f.segments) : {};
        const d = getDraft(key);
        if (d && f && sameSegments(d.segments, f.segments)) {
          p = d.picks;
          if (d.base === undefined) patchDraft(key, { base: f.base });
        } else if (d) {
          dropDraft(key);
          if (!isPristine(d)) toast(f ? `The conflict in ${path} changed: your merge of it was dropped` : `${path} isn't conflicted any more: your merge of it was dropped`);
        }
        picksRef.current = p;
        setPicksState(p);
        resetting.current = false;
        setLoaded({ status: 'ready', file: f });
      },
      (e: unknown) => { if (live) setLoaded({ status: 'error', message: errorMessage(e) }); },
    );
    return () => { live = false; };
  }, [ctx.repoId, ctx.worktree, path, key, reloads]);

  /** The editors' state into the draft: created when there's work (or `force`, for a save),
   * dropped when there's none. */
  const persist = useCallback((force = false) => {
    const e = eds.current;
    if (!e || !file || resetting.current || done.current) return;
    const s = e.snapshot();
    const p = picksRef.current;
    const prev = getDraft(key);
    if (!force && isPristine({ picks: p, edited: s.edited, typed: s.typed })) {
      dropDraft(key);
      return;
    }
    putDraft(key, {
      tabId: ctx.tabId, repo: ctx.repoId, worktree: ctx.worktree, path,
      base: prev ? prev.base : file.base, segments: file.segments, eol: file.eol,
      picks: p, text: s.text, spans: s.spans, edited: s.edited, typed: s.typed,
    });
  }, [file, key, ctx.tabId, ctx.repoId, ctx.worktree, path]);

  /** `next` becomes the picks; the regions it changes are rebuilt in the output (one edit). */
  const apply = useCallback((f: ConflictFilePayload, next: Picks) => {
    const prev = picksRef.current;
    picksRef.current = next;
    setPicksState(next);
    const list = f.segments.flatMap((s) => {
      if (s.kind !== 'conflict') return [];
      const lines = regionLines(s, next[s.id]);
      return prev[s.id] && sameLines(regionLines(s, prev[s.id]), lines) ? [] : [{ id: s.id, lines }];
    });
    eds.current?.setRegions(list, prev, next);
    persist();
  }, [persist]);

  useEffect(() => {
    if (!file || !textual || !currentEl.current || !incomingEl.current || !outputEl.current) return;
    const d = getDraft(key);
    const output = d?.text != null && d.spans ? { text: d.text, spans: d.spans, edited: d.edited, typed: d.typed } : undefined;
    const e = createMergeEditors({ current: currentEl.current, incoming: incomingEl.current, output: outputEl.current }, file, highlightLanguage(path, file.current?.text ?? ''), { picks: picksRef.current, output });
    eds.current = e;
    let timer: ReturnType<typeof setTimeout> | undefined;
    e.onToggle((id, side, line) => {
      const seg = file.segments.find((s): s is ConflictSegment => s.kind === 'conflict' && s.id === id);
      if (!seg) return;
      const p = picksRef.current;
      apply(file, line === 'hunk' ? toggleHunk(p, seg, side) : toggleLine(p, id, side, line));
    });
    e.onEdit(() => {
      clearTimeout(timer);
      timer = setTimeout(() => persist(), PERSIST_MS);
    });
    e.onPicksRestored((p) => {
      picksRef.current = p;
      setPicksState(p);
      persist();
    });
    e.onCursor(setCursor);
    // The count and arrows read the editors: render once they exist.
    rendered((n) => n + 1);
    const offLive = registerLive(key, {
      tabId: ctx.tabId,
      flush: (force) => { clearTimeout(timer); persist(force); },
      reset: () => {
        if (done.current) return;
        resetting.current = true;
        setReloads((n) => n + 1);
      },
      done: () => { done.current = true; },
    });
    return () => {
      clearTimeout(timer);
      // Going out of view (a hidden tab, another file): the work stays in the draft.
      persist(); // N1: a first edit still waiting on its debounce is kept too
      offLive();
      e.dispose();
      eds.current = null;
    };
  }, [file, textual, path, key, ctx.tabId, apply, persist]);

  useEffect(() => { eds.current?.setChecks(picks); }, [picks]);

  const take = (side: Side, on: boolean) => {
    if (file) apply(file, takeAll(picksRef.current, file.segments, side, on));
  };

  const save = async () => {
    // M7: one save at a time, its question included.
    if (!file || !eds.current || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      if (await saveMerge(key)) onResolved?.();
      else persist(); // a no or a failure: a draft made only for the save goes again
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  const step = (dir: 1 | -1) => {
    const e = eds.current;
    const r = e && nextRegion(e.regionsNow(), e.cursorLine(), dir);
    if (e && r) e.reveal(r.id);
  };

  // App-wide while the tool is shown (as the diff's change keys, J14): ahead of Monaco, whose F7
  // is its own and which has no Ctrl+S.
  useKeys('app', (e) => {
    // Ctrl+S arrives prevented already: the menu layer stops the browser's own Save page on it
    // (`blockBrowserChords`), so its `defaultPrevented` says nothing about another taker.
    const ctrlS = comboOf(e) === 'Ctrl+S';
    if ((e.defaultPrevented && !ctrlS) || root.current?.checkVisibility?.() === false) return;
    if (ctrlS) {
      e.preventDefault();
      if (file?.base !== null) void save();
      return 'handled';
    }
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (e.key === 'F7' && plain) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
      return 'handled';
    }
    if (e.key === ' ' && plain && !e.shiftKey && eds.current?.toggleAtCursor(e.target)) {
      e.preventDefault();
      return 'handled';
    }
  }, textual);

  const reload = () => setReloads((n) => n + 1);
  if (loaded.status === 'loading') return <div className="merge-message" aria-busy="true">Loading the conflict…</div>;
  if (loaded.status === 'error') {
    return (
      <div className="merge-message" role="alert">
        <p>Couldn't read the conflict in {path}: {loaded.message}</p>
        <button type="button" onClick={() => { fetched.current = ''; reload(); }}>Retry</button>
      </div>
    );
  }
  if (!file) return <div className="merge-message">{path} isn't conflicted any more.</div>;
  if (!textual) return <NonTextConflict ctx={ctx} file={file} onResolved={onResolved} onStale={(m) => { toast(m); reload(); }} />;
  const box = (side: Side) => {
    // M5: a side with no lines in any region has nothing to take.
    const has = sideHasLines(file.segments, side);
    const s = sideState(file.segments, picks, side);
    return <input type="checkbox" aria-label="Take all from this side" disabled={!has} checked={has && s === 'all'} ref={(el) => { if (el) el.indeterminate = has && s === 'some'; }} onChange={(ev) => take(side, ev.target.checked)} />;
  };
  // N6: no file to write over (conflictFile found none): saving can only be Stale.
  const deleted = file.base === null;
  const copyOutput = () => {
    const text = eds.current?.output.getValue();
    if (text !== undefined) void copyText(text).then(() => useToast.getState().show('Copied'), () => toast('Copy failed'));
  };
  const regions = eds.current?.regionsNow().sort((a, b) => a.start - b.start) ?? [];
  const at = regions.findIndex((r) => cursor >= r.start && cursor < r.start + Math.max(1, r.lines));
  const count = regions.length === 0 ? '' : at >= 0 ? `Conflict ${at + 1} of ${regions.length}` : `${regions.length} ${regions.length === 1 ? 'conflict' : 'conflicts'}`;
  return (
    <div ref={root} className="merge-tool">
      <div className="merge-panes">
        <section className="merge-pane merge-pane-current" aria-label="Current">
          <header><span className="merge-side">{`Current: ${file.labels.current}`}</span><label>{box('current')}<span aria-hidden="true">Take all from this side</span></label></header>
          <div ref={currentEl} className="merge-editor" />
        </section>
        <section className="merge-pane merge-pane-incoming" aria-label="Incoming">
          <header><span className="merge-side">{`Incoming: ${file.labels.incoming}`}</span><label>{box('incoming')}<span aria-hidden="true">Take all from this side</span></label></header>
          <div ref={incomingEl} className="merge-editor" />
        </section>
      </div>
      <section className="merge-output" role="region" aria-label="Output">
        <header>
          <span className="merge-side">Output</span>
          {file.eol === 'mixed' && <span className="merge-note" role="note">Mixed line endings: lines you type get one ending</span>}
          {deleted && (
            <>
              <span className="merge-note merge-deleted" role="alert">{path} was deleted on disk: copy the output, restore the file (Take current or Take incoming), then paste it in</span>
              <button type="button" onClick={copyOutput}>Copy output</button>
            </>
          )}
          <span className="merge-count" aria-live="polite">{count}</span>
          <HoverTooltip content="Previous conflict (Shift+F7)"><button type="button" className="icon-button" aria-label="Previous conflict" onClick={() => step(-1)}><ChevronUp size={14} /></button></HoverTooltip>
          <HoverTooltip content="Next conflict (F7)"><button type="button" className="icon-button" aria-label="Next conflict" onClick={() => step(1)}><ChevronDown size={14} /></button></HoverTooltip>
          <HoverTooltip content={deleted ? `${path} was deleted on disk` : 'Save (Ctrl+S)'}><button type="button" className="primary" aria-disabled={deleted || undefined} disabled={saving} onClick={() => { if (!deleted) void save(); }}>Save and mark resolved</button></HoverTooltip>
        </header>
        <div ref={outputEl} className="merge-editor" />
      </section>
    </div>
  );
}

/** The center panel for a conflicted WIP file (spec #2 §13.3), in place of the diff: the
 * header (path, ×) and the merge tool. It's the `diff` focus zone, as the diff panel is. A save
 * that resolves the file closes it; leaving unsaved work asks first (2B T11's leave guard). */
export function MergeToolPanel({ target }: { target: DiffTarget }) {
  const { tabId } = useRepoContext();
  const closeDiff = useRepoView((s) => s.closeDiff);
  const store = useRepoViewStore();
  const ref = useRef<HTMLElement>(null);
  const zone = useFocusZone('diff', ref);
  const worktree = target.new.kind === 'worktree' ? target.new.worktree : undefined;
  const ctx = useMemo(() => writeCtx(tabId, worktree), [tabId, worktree]);
  useEffect(() => installLeaveGuard(tabId, store), [tabId, store]);
  useEffect(() => installWindowCloseGuard(), []);
  // Esc closes the file (the app's), but Monaco's own overlays (find, a hover, …) close first.
  useEscapeOwner(useCallback((e: KeyboardEvent) => e.composedPath().some((n) => n === ref.current || (n instanceof Element && n.matches(ESCAPE_OWNER_AREAS))) && editorOwnsEscape(), []));
  return (
    <section ref={ref} className="merge-panel" role="region" aria-label="Merge tool" tabIndex={-1} {...zone}>
      <DiffHeader target={target} encoding="" onClose={closeDiff} />
      {ctx
        ? <MergeTool key={`${ctx.worktree}|${target.path}`} ctx={ctx} path={target.path} onResolved={closeDiff} />
        : <div className="merge-message" role="alert">Couldn't open the merge tool: this repository's tab isn't open.</div>}
    </section>
  );
}
