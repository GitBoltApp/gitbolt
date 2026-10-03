import { Suspense, useCallback, useEffect, type ComponentType, type LazyExoticComponent } from 'react';
import { create } from 'zustand';
import { tabStore } from '../app/tabStores';
import { PanelErrorBoundary } from '../errors/PanelErrorBoundary';
import type { DiffTarget } from './store';

/**
 * Views that take the graph's place in a tab's center panel (spec #3 §4.2 File History; §4.1's
 * interactive rebase editor, plan 3C, registers the same way). A feature registers its view at
 * import time; anything opens it in a tab with props. The later of a view and a file is on top
 * (`centerViewOnTop`): a view opened over a file (the diff toolbar's History) hides it, kept
 * underneath (× / Esc returns to it), and a file opened over a view hides the view. While the
 * view is on top, `RepoLayout` hides the graph and the app's Esc is the view's own
 * (`useAppEscape` stands aside).
 */
export interface CenterViewProps<P> { tabId: string; props: P; close(): void }
type View<P> = ComponentType<CenterViewProps<P>> | LazyExoticComponent<ComponentType<CenterViewProps<P>>>;

/** `over`: the file open in the tab when the view opened (the store's `diff`), or `null`. */
interface OpenView { kind: string; props: unknown; seq: number; over: DiffTarget | null }

const views = new Map<string, View<unknown>>();
const useCenterViews = create<{ byTab: Record<string, OpenView> }>(() => ({ byTab: {} }));
let seq = 0;
const hotReloading = () => import.meta.env.DEV && import.meta.env.MODE !== 'test';

/** Registers `Component` as center view `kind`; returns its removal. A second `kind` throws
 * (except on a dev-server hot update, which replaces it). */
export function registerCenterView<P>(kind: string, Component: View<P>): () => void {
  if (views.has(kind) && !hotReloading()) throw new Error(`center view ${kind} is already registered`);
  views.set(kind, Component as unknown as View<unknown>);
  return () => { if (views.get(kind) === (Component as unknown)) views.delete(kind); };
}

/** Opens view `kind` in tab `tabId`, replacing whichever was open there (a fresh mount). */
export function openCenterView<P>(tabId: string, kind: string, props: P): void {
  if (!views.has(kind)) throw new Error(`no center view ${kind}`);
  const over = tabStore(tabId)?.getState().diff ?? null;
  useCenterViews.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { kind, props, seq: ++seq, over } } }));
}

export function closeCenterView(tabId: string): void {
  if (!useCenterViews.getState().byTab[tabId]) return;
  useCenterViews.setState((s) => {
    const byTab = { ...s.byTab };
    delete byTab[tabId];
    return { byTab };
  });
}

/** The view open in `tabId`, if any (outside React). */
export const centerViewOf = (tabId: string): Omit<OpenView, 'seq'> | null => useCenterViews.getState().byTab[tabId] ?? null;
export const useCenterView = (tabId: string): Omit<OpenView, 'seq'> | null => useCenterViews((s) => s.byTab[tabId] ?? null);

/** What a right-click in a view's editor acts on (the Monaco menu, `menuEnv.monacoMenu`): the file
 * the editor shows, as the open file it would be (`target`), in worktree `root`. While a view is on
 * top, its editor's menu is built from this, never from the file hidden under it; a view that
 * gives none gets no menu. */
export interface CenterViewEditorFile { target: DiffTarget; root: string }
const useEditorFiles = create<{ byTab: Record<string, CenterViewEditorFile | null> }>(() => ({ byTab: {} }));

/** A view with an editor names its file (`null` while it shows none) for as long as it's mounted
 * and shown. Keep `file` stable (memoized) between changes. */
export function useCenterViewEditorFile(tabId: string, file: CenterViewEditorFile | null): void {
  useEffect(() => {
    useEditorFiles.setState((s) => ({ byTab: { ...s.byTab, [tabId]: file } }));
    return () => useEditorFiles.setState((s) => {
      if (s.byTab[tabId] !== file) return s;
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab };
    });
  }, [tabId, file]);
}

/** The file `tabId`'s shown view's editor holds, if any (outside React). */
export const centerViewEditorFile = (tabId: string): CenterViewEditorFile | null => useEditorFiles.getState().byTab[tabId] ?? null;
/** Whether `tabId`'s view has an editor to give a menu (`useCenterViewEditorFile` mounted). */
export const useCenterViewHasEditor = (tabId: string): boolean => useEditorFiles((s) => tabId in s.byTab);

/** Whether `open`, a tab's view, is on top of `diff`, its open file: no file is open, or it's the
 * one the view was opened over. A file opened since (`openFile` sets a new target, the same file
 * again included) is on top instead. */
export const centerViewOnTop = (open: Pick<OpenView, 'over'> | null, diff: DiffTarget | null): boolean => open !== null && (diff === null || diff === open.over);

/** Renders `tabId`'s open view (nothing when none). A lazy view loads behind an empty, busy frame.
 * Each opening has its own error boundary: a view that crashes offers Retry and Close (× and Esc
 * went with it), and the next view opened starts clean. */
export function CenterViewHost({ tabId }: { tabId: string }) {
  const open = useCenterViews((s) => s.byTab[tabId]);
  const close = useCallback(() => closeCenterView(tabId), [tabId]);
  const ViewComponent = open ? (views.get(open.kind) as ComponentType<CenterViewProps<unknown>> | undefined) : undefined;
  if (!open || !ViewComponent) return null;
  return (
    <PanelErrorBoundary key={open.seq} name="View" onClose={close}>
      <Suspense fallback={<section className="center-view-loading" aria-busy="true" />}>
        <ViewComponent tabId={tabId} props={open.props} close={close} />
      </Suspense>
    </PanelErrorBoundary>
  );
}
