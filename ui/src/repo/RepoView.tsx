import { Activity, useCallback, useEffect, useRef, useState } from 'react';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { DetailsPanel } from '../details/DetailsPanel';
import { releaseDetachedEditors } from '../diff/editorRelease';
import { displayedOrder } from '../files/fileListPrefs';
import { GraphView } from '../graph/GraphView';
import { useAppEscape } from './escape';
import { useFocusZone } from './focus';
import { LazyDiffPanel } from './LazyDiffPanel';
import { PanelResizer } from './PanelResizer';
import { createServices, type RepoServices } from './services';
import { createRepoViewStore, RepoViewContext, selectedIndex, useRepoView, useRepoViewStore, type DiffTarget } from './store';
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
  // → and Enter open the first changed file as its list displays it, and the keyboard follows
  // it into the list (feedback J2; with nothing to open, it stays in the graph).
  const onUnhandledKey = useCallback((key: string) => {
    if (key !== 'ArrowRight' && key !== 'Enter') return false;
    store.getState().openFirstFile(displayedOrder);
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
    return kind === 'compare' || kind === 'compareWorktree' ? 'Compare' : kind === 'wip' ? 'Working tree changes' : 'Commit details';
  });
  const [prefW, setRightW] = useState<number>(RIGHT_PANEL.default);
  const maxW = useRightPanelMax();
  // The chosen width, re-clamped to the window: widening the window again restores it.
  const rightW = Math.min(prefW, maxW);
  // Esc, from wherever the focus is (feedback J4): one handler on `window`, not per zone.
  const viewRef = useRef<HTMLDivElement>(null);
  useAppEscape(store, viewRef);
  // The kept diff panel may unmount with the view while hidden, when its own attach cleanup has
  // already run (J16): let the shared editor go of its box. Outside the panel's `<Activity>`, so
  // it runs on this unmount; a microtask, once the view's DOM is gone.
  useEffect(() => () => queueMicrotask(releaseDetachedEditors), []);
  // Ctrl+W closes the open file from anywhere in the view, even with focus on <body> (I1): it's
  // in the key router's `app` layer (`useAppEscape`, above), next to Esc. With none open it does
  // nothing yet; plan 1C makes it close the tab.
  return (
    <div ref={viewRef} className="repo-view" data-testid="repo-view">
      <main className="center-panel">
        <Activity mode={diffOpen ? 'hidden' : 'visible'}>
          <ConnectedGraph />
        </Activity>
        {/* J16: once opened, the diff panel stays mounted, hidden while no file is open, so a
            reopen wakes the same panel and editor (no lazy-chunk suspense, no re-attach). Hidden,
            it runs no effects: no keys, observers, timers or focus. */}
        {kept && (
          <Activity mode={diffOpen ? 'visible' : 'hidden'}>
            <LazyDiffPanel target={diff ?? kept.target} session={kept.session} />
          </Activity>
        )}
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
