import { Activity, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { DetailsPanel } from '../details/DetailsPanel';
import { displayedOrder } from '../files/fileListPrefs';
import { GraphView } from '../graph/GraphView';
import { isCloseFileKey, isEditorKey } from '../ui/keys';
import { useFocusZone } from './focus';
import { LazyDiffPanel } from './LazyDiffPanel';
import { PanelResizer } from './PanelResizer';
import { createServices, type RepoServices } from './services';
import { createRepoViewStore, RepoViewContext, selectedIndex, useRepoView, useRepoViewStore } from './store';
import './repo.css';

export const RIGHT_PANEL = { min: 280, max: 720, default: 400 } as const;
/** The narrowest the center panel gets from widening the details panel. */
export const CENTER_MIN = 320;

/** The details panel's widest, so a narrow window still leaves the center CENTER_MIN px.
 * Follows window resizes. */
function useRightPanelMax(): number {
  const compute = () => Math.max(RIGHT_PANEL.min, Math.min(RIGHT_PANEL.max, window.innerWidth - CENTER_MIN));
  const [max, setMax] = useState(compute);
  useEffect(() => {
    const onResize = () => setMax(compute());
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return max;
}

/**
 * One repository's view: the graph (or a diff) in the center, details on the right. Plan 1C
 * wraps one per tab inside `<Activity>`. Pass the repo's `services` (App's per-repo instance,
 * whose message cache the whole view shares); the fallback builds its own.
 */
export function RepoView({ repo, repoPath, graph, services }: { repo: number; repoPath: string; graph: GraphPayload; services?: RepoServices }) {
  const [store] = useState(() => createRepoViewStore(repo, repoPath, graph, services ?? createServices(repo)));
  useEffect(() => {
    store.getState().setGraph(graph);
  }, [store, graph]);
  return (
    <RepoViewContext value={store}>
      <RepoLayout />
    </RepoViewContext>
  );
}

/** GraphView driven by the store. Every callback it passes is stable, so the memoized rows
 * re-render only when their own selection or compare mark changes. */
function ConnectedGraph() {
  const graph = useRepoView((s) => s.graph);
  const repoPath = useRepoView((s) => s.repoPath);
  const messages = useRepoView((s) => s.services.messages);
  const selected = useRepoView(selectedIndex);
  const marks = useRepoView((s) => s.marks);
  const selectRow = useRepoView((s) => s.selectRow);
  const store = useRepoViewStore();
  const gridRef = useRef<HTMLDivElement>(null);
  const zone = useFocusZone('graph', gridRef);
  const onUnhandledKey = useCallback((key: string) => {
    const s = store.getState();
    if (key === 'ArrowRight') s.setFocus('files');
    else if (key === 'Enter') s.openFirstFile(displayedOrder);
    else return false;
    return true;
  }, [store]);
  return (
    <GraphView
      graph={graph}
      repoId={repoPath}
      messages={messages}
      selected={selected}
      onSelect={selectRow}
      compare={marks}
      onUnhandledKey={onUnhandledKey}
      gridRef={gridRef}
      gridProps={zone}
    />
  );
}

function RepoLayout() {
  const store = useRepoViewStore();
  const diff = useRepoView((s) => s.diff);
  const diffOpen = diff !== null;
  // The panel appears with its first selection's content, all loaded (feedback F12).
  const hasPanel = useRepoView((s) => s.panel !== null);
  const pending = useRepoView((s) => s.panelPending);
  // The right panel's landmark name follows what it shows.
  const panelLabel = useRepoView((s) => {
    const kind = s.panel?.selection.kind;
    return kind === 'compare' || kind === 'compareWorktree' ? 'Compare' : kind === 'wip' ? 'Working tree changes' : 'Commit details';
  });
  const [prefW, setRightW] = useState<number>(RIGHT_PANEL.default);
  const maxW = useRightPanelMax();
  // The chosen width, re-clamped to the window: widening the window again restores it.
  const rightW = Math.min(prefW, maxW);
  // Escape anywhere in the view, unless something inside already handled it. In the file list
  // or the diff it closes the diff and returns to the graph (`closeDiff`); in the graph (or
  // elsewhere) it leaves compare mode.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const s = store.getState();
    // Ctrl+W closes the open file from anywhere in the view (the diff panel takes it first when it
    // has focus). With none open it does nothing yet; plan 1C makes it close the tab.
    if (isCloseFileKey(e)) {
      if (!s.diff) return;
      s.closeDiff();
      e.preventDefault();
      return;
    }
    // An editor overlay's Esc (DiffPanel marks it): not the view's.
    if (e.key !== 'Escape' || isEditorKey(e.nativeEvent)) return;
    const inFiles = e.target instanceof Element && e.target.closest('[data-focus-zone="files"]') !== null;
    if (s.diff || inFiles) s.closeDiff();
    else if (s.selection.kind === 'compare' || s.selection.kind === 'compareWorktree' || s.marks.a !== null) {
      s.exitCompare();
      // From the compare header (Swap or ×, which unmount), focus would drop to <body>.
      const inGraph = e.target instanceof Element && e.target.closest('[data-focus-zone="graph"]') !== null;
      if (!inGraph) s.setFocus('graph');
    } else return;
    e.preventDefault();
  };
  return (
    <div className="repo-view" data-testid="repo-view" onKeyDown={onKeyDown}>
      <main className="center-panel">
        <Activity mode={diffOpen ? 'hidden' : 'visible'}>
          <ConnectedGraph />
        </Activity>
        {diff && <LazyDiffPanel target={diff} />}
      </main>
      {/* Hidden until something is selected, so a fresh view gives the graph the full width
          (plan 1B deviation 8). */}
      {hasPanel && (
        <>
          <PanelResizer width={rightW} min={RIGHT_PANEL.min} max={maxW} onChange={setRightW} />
          <aside className="right-panel" aria-label={panelLabel} aria-busy={pending} style={{ width: rightW }}>
            {/* The next selection is loading: the previous one stays, and past ~150 ms (CSS
                delay) a thin progress line shows (feedback F12). */}
            {pending && <div className="panel-busy" data-testid="panel-busy" aria-hidden="true" />}
            <DetailsPanel />
          </aside>
        </>
      )}
    </div>
  );
}
