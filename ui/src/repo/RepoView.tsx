import { Activity, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { loadMonacoHost } from '../diff/monaco/load';
import { PanelErrorBoundary } from '../errors/PanelErrorBoundary';
import { DetailsPanel } from '../details/DetailsPanel';
import { releaseDetachedEditors } from '../diff/editorRelease';
import { displayedOrder } from '../files/fileListPrefs';
import { GraphView } from '../graph/GraphView';
import { rebasingChip } from '../integrate/rebasing';
import type { RowDim } from '../graph/rowDim';
import { commitMenu, labelMenu, monacoMenu, warmCommitMenu, wipMenu } from '../menu/menuEnv';
import { graphLabelDoubleClick, graphRowDoubleClick } from '../graph/rowActions';
import { useRowEditor } from '../graph/rowEditor';
import { openContextMenu, useMenu, type MenuEventLike } from '../menu/menuStore';
import { useAppEscape } from './escape';
import { useFocusZone } from './focus';
import { LazyDiffPanel } from './LazyDiffPanel';
import { PanelResizer } from './PanelResizer';
import { createServices, type RepoServices } from './services';
import { createRepoViewStore, RepoViewContext, selectedIndex, useRepoView, useRepoViewStore, openWorktree, type DiffTarget, type RepoViewStore } from './store';
import './repo.css';

export const RIGHT_PANEL = { min: 280, max: 720, default: 400 } as const;
/** The narrowest the center panel gets from widening the details panel. */
export const CENTER_MIN = 320;

/** The room the view has to its right-hand side: from its own left edge (past the sidebar, or its
 * narrow strip, and the sidebar's resizer) to the window's right edge. */
const roomOf = (view: HTMLElement | null) => window.innerWidth - (view?.getBoundingClientRect().left ?? 0);

/** The details panel's widest, so the center keeps CENTER_MIN px of what the view really has:
 * the window less the sidebar (or its narrow strip), which a wide panel would otherwise squeeze
 * the center against. Follows window resizes and the view's own (the sidebar's resizer, its
 * collapse to the strip). */
function useRightPanelMax(viewRef: RefObject<HTMLElement | null>): number {
  const compute = () => Math.max(RIGHT_PANEL.min, Math.min(RIGHT_PANEL.max, roomOf(viewRef.current) - CENTER_MIN));
  const [max, setMax] = useState(compute);
  useEffect(() => {
    const update = () => setMax(compute());
    window.addEventListener('resize', update);
    // The sidebar changing width moves the view's left edge without a window resize.
    const observer = new ResizeObserver(update);
    if (viewRef.current) observer.observe(viewRef.current);
    update();
    return () => {
      window.removeEventListener('resize', update);
      observer.disconnect();
    };
  }, [viewRef]);
  return max;
}

/**
 * One repository's view: the graph (or a diff) in the center, details on the right. Plan 1C
 * wraps one per tab inside `<Activity>`, and the tab owns the view's `store` (ruling R3: the
 * tab's registry entry, `app/tabStores.ts`), so everything else in the tab (Ctrl+W, menus, find,
 * the sidebar) reaches the same selection and open file. Without a `store`, the view makes its
 * own from `services` (the repo's per-repo caches; the fallback builds its own). Keep `store`
 * the same for the view's lifetime. `graphOverlay` (plan 1C's Find box) floats over the graph
 * panel, and hides with the graph while a file is open.
 */
export function RepoView({ repo, repoPath, graph, services, store: given, graphOverlay }: { repo: number; repoPath: string; graph: GraphPayload; services?: RepoServices; store?: RepoViewStore; graphOverlay?: ReactNode }) {
  const [store] = useState(() => given ?? createRepoViewStore(repo, repoPath, graph, services ?? createServices(repo)));
  useEffect(() => {
    store.getState().setGraph(graph);
  }, [store, graph]);
  return (
    <RepoViewContext value={store}>
      <RepoLayout graphOverlay={graphOverlay} />
    </RepoViewContext>
  );
}

/** GraphView driven by the store. Every callback it passes is stable, so the memoized rows
 * re-render only when their own selection changes. */
function ConnectedGraph() {
  const graph = useRepoView((s) => s.graph);
  const repoPath = useRepoView((s) => s.repoPath);
  const messages = useRepoView((s) => s.services.messages);
  const selected = useRepoView(selectedIndex);
  // A compare's or multi-selection's rows (K27); GraphView hands each row only its own boolean,
  // so a change re-renders just the rows that join or leave.
  const pickedRows = useRepoView((s) => s.picks.rows);
  const alsoSelected = useMemo(() => new Set(pickedRows), [pickedRows]);
  const selectRow = useRepoView((s) => s.selectRow);
  const store = useRepoViewStore();
  // --- 2D T18: the chip of a branch being rebased in the active worktree (refetched with the graph) ---
  const worktree = useRepoView(openWorktree);
  const rebasing = useMemo(() => rebasingChip(graph, worktree), [graph, worktree]);
  // --- end 2D T18 ---
  // Find's matches (plan 1C): the rest dim at the 'filter' level (rowDim.ts). One O(1) lookup per
  // rendered row; GraphView hands each row only its own level, so a new search re-renders just
  // the rows whose level changed.
  const filterKeep = useRepoView((s) => s.filterKeep);
  const rowDim = useMemo<RowDim | null>(() => (filterKeep ? { dimmed: (i) => !filterKeep.has(graph.rows[i]?.id ?? '') && 'filter' } : null), [filterKeep, graph]);
  const gridRef = useRef<HTMLDivElement>(null);
  const zone = useFocusZone('graph', gridRef);
  // → and Enter open the first changed file as its list displays it, and the keyboard follows
  // it into the list (feedback J2; with nothing to open, it stays in the graph).
  const onUnhandledKey = useCallback((key: string) => {
    if (key !== 'ArrowRight' && key !== 'Enter') return false;
    store.getState().openFirstFile(displayedOrder);
    return true;
  }, [store]);
  // Plan 1C Task 15: the commit menu (a plain right-click on the row) and the commit/tag menu on
  // a branch or tag label chip. Both build synchronously from the store (spec §7: no backend
  // call before a menu shows).
  const services = useRepoView((s) => s.services);
  useEffect(() => warmCommitMenu(services), [services]);
  const onContextMenu = useCallback((e: MenuEventLike, row: RowPayload) => {
    openContextMenu(e, commitMenu(store, row));
  }, [store]);
  const onLabelContextMenu = useCallback((e: MouseEvent<HTMLElement>, row: RowPayload, label: RefLabel) => {
    openContextMenu(e, labelMenu(store, row, label));
  }, [store]);
  // --- 2C T9: double-clicks (registered by the features that own them) and the WIP row's menu ---
  const onLabelDoubleClick = useCallback((row: RowPayload, label: RefLabel) => { graphLabelDoubleClick(store, row, label); }, [store]);
  const onRowDoubleClick = useCallback((row: RowPayload) => { graphRowDoubleClick(store, row); }, [store]);
  const onWipContextMenu = useCallback((e: MenuEventLike, row: RowPayload) => { openContextMenu(e, wipMenu(store, row)); }, [store]);
  // --- end 2C T9 ---
  // An inline editor on a row (Create branch here's name input, UX round 1).
  const rowEditor = useRowEditor(store);
  return (
    <GraphView
      graph={graph}
      repoId={repoPath}
      messages={messages}
      selected={selected}
      onSelect={selectRow}
      alsoSelected={alsoSelected}
      onUnhandledKey={onUnhandledKey}
      gridRef={gridRef}
      gridProps={zone}
      onContextMenu={onContextMenu}
      onLabelContextMenu={onLabelContextMenu}
      onLabelDoubleClick={onLabelDoubleClick}
      onRowDoubleClick={onRowDoubleClick}
      onWipContextMenu={onWipContextMenu}
      rowDim={rowDim}
      rebasing={rebasing}
      rowEditor={rowEditor}
    />
  );
}

/** The details panel in its error boundary, reset by the selection. Its own component, so only it
 * subscribes to the selection: RepoLayout re-rendering on every move would re-render the hidden,
 * kept diff panel too (J16 zero work). */
function DetailsBoundary() {
  const selection = useRepoView((s) => s.panel?.selection);
  return <PanelErrorBoundary name="Details" resetKey={selection}><DetailsPanel /></PanelErrorBoundary>;
}

function RepoLayout({ graphOverlay }: { graphOverlay?: ReactNode }) {
  const store = useRepoViewStore();
  const diff = useRepoView((s) => s.diff);
  const diffOpen = diff !== null;
  // The last file opened: what the kept (hidden) diff panel holds while none is (J16). `session`
  // counts the opens, so the panel knows a reopen from a switch while open.
  const [kept, setKept] = useState<{ target: DiffTarget; session: number; closed: boolean } | null>(null);
  if (!diff && kept && !kept.closed) setKept({ ...kept, closed: true });
  if (diff && (!kept || kept.closed || kept.target !== diff)) setKept({ target: diff, session: (kept?.session ?? 0) + (!kept || kept.closed ? 1 : 0), closed: false });
  // The panel appears with its first selection's content, all loaded (feedback F12).
  const hasPanel = useRepoView((s) => s.panel !== null);
  const pending = useRepoView((s) => s.panelPending);
  // The right panel's landmark name follows what it shows.
  const panelLabel = useRepoView((s) => {
    const kind = s.panel?.selection.kind;
    return kind === 'compare' || kind === 'compareWorktree' ? 'Compare' : kind === 'multi' ? 'Selected commits' : kind === 'wip' ? 'Working tree changes' : 'Commit details';
  });
  const [prefW, setRightW] = useState<number>(RIGHT_PANEL.default);
  const viewRef = useRef<HTMLDivElement>(null);
  const maxW = useRightPanelMax(viewRef);
  // The chosen width, re-clamped to the window: widening the window again restores it.
  const rightW = Math.min(prefW, maxW);
  // PanelResizer writes the live width straight here while dragging (rAF-coalesced), bypassing
  // React until the drag ends — a drag never re-renders the graph, the diff editor or the
  // details panel per pointer event.
  const rightPanelRef = useRef<HTMLElement>(null);
  // Esc, from wherever the focus is (feedback J4): one handler on `window`, not per zone.
  useAppEscape(store, viewRef);
  // The kept diff panel may unmount with the view while hidden, when its own attach cleanup has
  // already run (J16): let the shared editor go of its box. Outside the panel's `<Activity>`, so
  // it runs on this unmount; a microtask, once the view's DOM is gone.
  useEffect(() => () => queueMicrotask(releaseDetachedEditors), []);
  // Plan 1C Task 15's Monaco menu, installed once a diff has been opened (not just while the
  // panel is on screen: there's nothing to detach before the first open, and a right-click right
  // after a reopen must still work). The boolean, not `kept` itself, is the dependency: `kept`'s
  // identity changes on every file switch, and re-registering the same handler each time would be
  // wasted work. Deferred behind it so this never triggers Monaco's own lazy chunk (spec §10.3)
  // on a tab that never opens a diff; by the time it flips, `LazyDiffPanel` is already loading it.
  const diffEverOpened = kept !== null;
  useEffect(() => {
    if (!diffEverOpened) return;
    let live = true;
    void loadMonacoHost().then((host) => {
      if (!live) return;
      host.setContextMenuHandler((e) => {
        const build = monacoMenu(store, e);
        const rows = build();
        if (rows.length > 0) useMenu.getState().show(rows, e.x, e.y, performance.now(), build);
      });
    });
    return () => {
      live = false;
      void loadMonacoHost().then((host) => host.setContextMenuHandler(null)).catch(() => {});
    };
  }, [diffEverOpened, store]);
  // Ctrl+W closes the open file from anywhere, even with focus on <body> (I1), else the tab: the
  // app's shortcut (`app/coreActions.ts`), acting on the active tab's store.
  return (
    <div ref={viewRef} className="repo-view" data-testid="repo-view">
      <main className="center-panel">
        <Activity mode={diffOpen ? 'hidden' : 'visible'}>
          <PanelErrorBoundary name="Graph"><ConnectedGraph /></PanelErrorBoundary>
          {graphOverlay}
        </Activity>
        {/* J16: once opened, the diff panel stays mounted, hidden while no file is open, so a
            reopen wakes the same panel and editor (no lazy-chunk suspense, no re-attach). Hidden,
            it runs no effects: no keys, observers, timers or focus. */}
        {kept && (
          <Activity mode={diffOpen ? 'visible' : 'hidden'}>
            <PanelErrorBoundary name="Diff" resetKey={diff?.key ?? kept.target.key}><LazyDiffPanel target={diff ?? kept.target} session={kept.session} /></PanelErrorBoundary>
          </Activity>
        )}
      </main>
      {/* Hidden until something is selected, so a fresh view gives the graph the full width
          (plan 1B deviation 8). */}
      {hasPanel && (
        <>
          <PanelResizer defaultWidth={RIGHT_PANEL.default} width={rightW} min={RIGHT_PANEL.min} max={maxW} onChange={setRightW} panelRef={rightPanelRef} />
          <aside ref={rightPanelRef} className="right-panel" aria-label={panelLabel} aria-busy={pending} style={{ width: rightW }}>
            {/* The next selection is loading: the previous one stays, and past ~150 ms (CSS
                delay) a thin progress line shows (feedback F12). */}
            {pending && <div className="panel-busy" data-testid="panel-busy" aria-hidden="true" />}
            <DetailsBoundary />
          </aside>
        </>
      )}
    </div>
  );
}
