import { Component, lazy, Suspense, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { errorMessage } from '../api/client';
import { useFocusZone } from './focus';
import { useRepoView, type DiffTarget } from './store';
import { isWipKey } from './wipLists';

type PanelModule = { default: ComponentType<{ target: DiffTarget; session?: number }> };

// Lazy: the diff panel reaches Shiki's language registry and the Monaco loader, which must stay
// out of the startup chunk (spec §10.3; `npm run build` checks it).
const loadDiffPanel = (): Promise<PanelModule> => import('../diff/DiffPanel').then((m) => ({ default: m.DiffPanel }));
// Spec #2 §13.3: a conflicted WIP file opens the merge tool in place of the diff (Monaco too).
const loadMergeTool = (): Promise<PanelModule> => import('../conflicts/MergeTool').then((m) => ({ default: m.MergeToolPanel }));

/** A conflicted file of a WIP row (status `U`): the merge tool's, not the diff's. */
export const isConflictTarget = (t: DiffTarget) => t.status === 'U' && isWipKey(t.key);

interface BoundaryProps { resetKey: string; fallback: (error: unknown) => ReactNode; children: ReactNode }
interface BoundaryState { failed: boolean; error: unknown; key: string }

/** Catches a failed chunk load or a render error; a new `resetKey` (another file, or File/Diff
 * View) clears it. */
class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { failed: true, error };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey === state.key ? null : { failed: false, error: null, key: props.resetKey };
  }

  render() {
    return this.state.failed ? this.props.fallback(this.state.error) : this.props.children;
  }
}

/** The failed panel's stand-in. It's the `diff` focus zone, as the panel is, so → from the
 * files lands on it and Retry/Close are a Tab away. */
function DiffError({ error, onRetry, onClose }: { error: unknown; onRetry: () => void; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const zone = useFocusZone('diff', ref);
  return (
    <section ref={ref} className="diff-panel" role="region" aria-label="Diff" tabIndex={-1} {...zone}>
      <div className="diff-error">
        <div role="alert">Couldn't show this diff: {errorMessage(error)}</div>
        <div className="diff-error-actions">
          <button type="button" onClick={onRetry}>Retry</button>
          <button type="button" aria-label="Close diff" onClick={onClose}>Close</button>
        </div>
      </div>
    </section>
  );
}

/**
 * The diff panel, loaded on the first diff. While its chunk loads, the panel's empty frame
 * (`aria-busy`); if the load or the panel fails, the error with Retry (a fresh import: React.lazy
 * would replay the rejection) and Close. `session` goes to the panel (J16). A conflicted WIP
 * file gets the merge tool instead (spec #2 §13.3). `load` and `loadMerge` are test seams.
 */
export function LazyDiffPanel({ target, session, load = loadDiffPanel, loadMerge = loadMergeTool }: { target: DiffTarget; session?: number; load?: () => Promise<PanelModule>; loadMerge?: () => Promise<PanelModule> }) {
  const closeDiff = useRepoView((s) => s.closeDiff);
  const [attempt, setAttempt] = useState(0);
  const merge = isConflictTarget(target);
  // `attempt` is a dependency on purpose: each Retry makes a fresh lazy() that imports again.
  const Panel = useMemo(() => lazy(load), [load, attempt]);
  const MergePanel = useMemo(() => lazy(loadMerge), [loadMerge, attempt]);
  if (merge) {
    return (
      <Boundary
        resetKey={`${attempt}|merge|${target.key}`}
        fallback={(error) => <DiffError error={error} onRetry={() => setAttempt((n) => n + 1)} onClose={closeDiff} />}
      >
        <Suspense fallback={<section className="diff-panel" role="region" aria-label="Merge tool" aria-busy="true" />}>
          <MergePanel target={target} />
        </Suspense>
      </Boundary>
    );
  }
  return (
    <Boundary
      resetKey={`${attempt}|${target.view}|${target.key}`}
      fallback={(error) => <DiffError error={error} onRetry={() => setAttempt((n) => n + 1)} onClose={closeDiff} />}
    >
      <Suspense fallback={<section className="diff-panel" role="region" aria-label="Diff" aria-busy="true" />}>
        <Panel target={target} session={session} />
      </Suspense>
    </Boundary>
  );
}
