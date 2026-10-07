import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { TabSlotProps } from '../../app/slots';
import { useAppState } from '../../app/state';
import { tabStore, useTabView } from '../../app/tabStores';
import { PanelErrorBoundary } from '../../errors/PanelErrorBoundary';
import { centerViewOnTop, useCenterView } from '../../repo/centerView';
import type { RepoViewStore } from '../../repo/store';
import { escOwners } from '../../app/modalKeys';
import { escapeDisarms } from '../arm/store';
import { isDismissKey } from '../HoverTooltip';
import { useKeys } from '../keyRouter';
import { isEditableTarget } from '../keys';
import { onResetDoubleClick } from '../resetHandle';
import { canDock, closeFlyout, DOCK_W, dockWidth, flyoutComponent, flyoutDockable, FlyoutDockContext, flyoutWidth, FLYOUT_W, setDockPrefs, useFlyout, useFlyoutDock, type FlyoutDock } from './flyout';
import './flyout.css';

const STEP = 16;
/** Stands in for a tab with no view store yet. */
const NO_STORE = createStore(() => ({ diff: null })) as unknown as RepoViewStore;

/** A center view (File History, the rebase editor) is on top in the tab. */
function useViewOnTop(tabId: string): boolean {
  const view = useCenterView(tabId);
  const diff = useStore(useTabView(tabId)?.store ?? NO_STORE, (s) => s.diff);
  return centerViewOnTop(view, diff);
}

/**
 * The tab's open flyout (spec #4 §5), over the left of the tab's center: its left edge is the
 * sidebar's right edge (or its narrow strip's). It stays over an open file, and hides while a
 * center view is on top (that view owns the center and its Esc). A dockable one left docked is a
 * pane instead, beside the graph (which shrinks to fit), while the center has room for both.
 */
export function FlyoutHost({ tab }: TabSlotProps) {
  const tabId = tab.id;
  const open = useFlyout(tabId);
  const onTop = useViewOnTop(tabId);
  const fileOpen = useStore(useTabView(tabId)?.store ?? NO_STORE, (s) => s.diff !== null);
  // Read only while this tab has a flyout open, so a hidden tab never re-renders on another's resize.
  const preferred = useAppState((s) => (open !== null ? s.profile.flyoutWidth : null));
  const dockPref = useFlyoutDock((s) => (open !== null ? s : null));
  const updateProfile = useAppState((s) => s.updateProfile);
  const hostRef = useRef<HTMLDivElement>(null);
  /** Ends a drag in progress (its window listeners), also when the host unmounts mid-drag. */
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);
  const [room, setRoom] = useState(1200);
  const close = useCallback(() => closeFlyout(tabId), [tabId]);
  const dockable = open !== null && flyoutDockable(open.kind);
  const roomToDock = canDock(room);
  const docked = dockable && !!dockPref?.docked && roomToDock;
  // A file opened while it floats over the graph shows on top: the flyout steps aside (kept, with
  // its scroll) until the file closes. Docked, it's a pane beside the file and stays.
  const underFile = fileOpen && !docked;
  const shown = open !== null && !onTop && !underFile;
  const dock = useMemo<FlyoutDock>(() => ({
    dockable,
    docked,
    canDock: roomToDock,
    toggle: () => setDockPrefs({ docked: !docked }),
  }), [dockable, docked, roomToDock]);

  // The center's width, which bounds the flyout's.
  useLayoutEffect(() => {
    const parent = hostRef.current?.parentElement;
    if (!shown || !parent) return;
    const measure = () => setRoom(parent.clientWidth || 1200);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [shown]);

  // Esc, in the key router's `overlay` layer: inside the flyout it closes it (an armed control
  // there disarms first); elsewhere it's the app's (close the file, leave a compare), and closes
  // the flyout only when the app's has nothing to do. Never a key typed in another text box.
  // Docked, it's a pane like the graph: Esc closes it only from inside.
  useKeys('overlay', (e) => {
    if (!isDismissKey(e) || e.defaultPrevented) return;
    const host = hostRef.current;
    if (!host || host.checkVisibility?.() === false) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && host.contains(t)) {
      if (escapeDisarms(e)) return 'handled';
      // An inline popup inside the flyout (the Markdown field's emoji/@ list) takes the Esc first.
      if ([...escOwners].some((own) => own(e))) { e.preventDefault(); return 'handled'; }
      close();
      e.preventDefault();
      return 'handled';
    }
    if (docked || isEditableTarget(t)) return;
    const s = tabStore(tabId)?.getState();
    if (s && (s.diff || s.selection.kind === 'compare' || s.selection.kind === 'compareWorktree' || s.selection.kind === 'multi')) return;
    close();
    e.preventDefault();
    return 'handled';
  }, shown);

  if (!open) return null;
  const Component = flyoutComponent(open.kind);
  if (!Component) return null;
  const bounds = docked ? DOCK_W : FLYOUT_W;
  const fit = (px: number | null) => (docked ? dockWidth(px, room) : flyoutWidth(px, room));
  const width = fit(docked ? dockPref?.width ?? null : preferred);
  const commit = (px: number) => {
    const w = Math.round(Math.min(bounds.max, Math.max(bounds.min, px)));
    if (docked) setDockPrefs({ width: w });
    else updateProfile((p) => ({ ...p, flyoutWidth: w }));
  };
  const reset = () => {
    if (docked) setDockPrefs({ width: null });
    else updateProfile((p) => ({ ...p, flyoutWidth: null }));
  };
  // The drag writes the width straight to the element and commits it once, on release.
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const el = hostRef.current;
    if (!el) return;
    const x0 = e.clientX;
    let last = width;
    const move = (ev: PointerEvent) => {
      last = fit(width + ev.clientX - x0);
      el.style.width = `${last}px`;
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      endDrag.current = null;
    };
    const up = () => {
      stop();
      if (last !== width) commit(last);
    };
    endDrag.current?.();
    endDrag.current = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') reset();
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') commit(width + (e.key === 'ArrowRight' ? STEP : -STEP));
    else return;
    e.preventDefault();
  };
  return (
    <div ref={hostRef} className={`flyout-host${docked ? ' docked' : ''}${underFile ? ' under-file' : ''}`} style={{ width }} hidden={onTop}>
      <FlyoutDockContext value={dock}>
        <PanelErrorBoundary key={open.seq} name="Panel" onClose={close}>
          <Suspense fallback={<section className="flyout" aria-busy="true" />}>
            <Component tabId={tabId} props={open.props} close={close} />
          </Suspense>
        </PanelErrorBoundary>
      </FlyoutDockContext>
      <div
        className="flyout-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the panel"
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={onKey}
        {...onResetDoubleClick(reset)}
      />
    </div>
  );
}
