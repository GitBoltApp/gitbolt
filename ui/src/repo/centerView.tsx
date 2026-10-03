import { Suspense, useCallback, useEffect, type ComponentType, type LazyExoticComponent } from 'react';
import { create, useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { tabStore, useTabView } from '../app/tabStores';
import { PanelErrorBoundary } from '../errors/PanelErrorBoundary';
import type { DiffTarget, RepoViewStore, SelectionSnapshot } from './store';

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

/**
 * How a view sits in the tab's layout (UX round 1, R2):
 * - `sidebar`: `'narrow'` (the default: a file view, File History / Blame) narrows the left
 *   sidebar to its strip while the view is on top, and a click on the strip closes the view
 *   (`leaveFileView`); `'hide'` (the rebase editor) takes the sidebar's place too, for as long
 *   as the view is open, so nothing there can navigate away from it.
 * - `drivesSelection`: the view puts commits in the details panel (the tab's selection); closing
 *   it (or opening another view in its place) puts back the selection the graph had.
 */
export interface CenterViewOptions { sidebar?: 'narrow' | 'hide'; drivesSelection?: boolean }

/** `over`: the file open in the tab when the view opened (the store's `diff`), or `null`.
 * `restore`: the graph's selection to put back on close (`drivesSelection`). */
interface OpenView { kind: string; props: unknown; seq: number; over: DiffTarget | null; restore: SelectionSnapshot | null }

const views = new Map<string, View<unknown>>();
const options = new Map<string, CenterViewOptions>();
const optionsOf = (kind: string): CenterViewOptions => options.get(kind) ?? {};
const useCenterViews = create<{ byTab: Record<string, OpenView> }>(() => ({ byTab: {} }));
let seq = 0;
const hotReloading = () => import.meta.env.DEV && import.meta.env.MODE !== 'test';

/** Registers `Component` as center view `kind`; returns its removal. A second `kind` throws
 * (except on a dev-server hot update, which replaces it). */
export function registerCenterView<P>(kind: string, Component: View<P>, opts: CenterViewOptions = {}): () => void {
  if (views.has(kind) && !hotReloading()) throw new Error(`center view ${kind} is already registered`);
  views.set(kind, Component as unknown as View<unknown>);
  options.set(kind, opts);
  return () => {
    if (views.get(kind) !== (Component as unknown)) return;
    views.delete(kind);
    options.delete(kind);
  };
}

/** Opens view `kind` in tab `tabId`, replacing whichever was open there (a fresh mount). A view
 * that drives the selection keeps the graph's from before the first of them opened. */
export function openCenterView<P>(tabId: string, kind: string, props: P): void {
  if (!views.has(kind)) throw new Error(`no center view ${kind}`);
  const store = tabStore(tabId);
  const prev = useCenterViews.getState().byTab[tabId];
  let restore: SelectionSnapshot | null = null;
  if (optionsOf(kind).drivesSelection) restore = prev?.restore ?? store?.getState().snapshotSelection() ?? null;
  else if (prev?.restore) store?.getState().restoreSelection(prev.restore);
  const over = store?.getState().diff ?? null;
  useCenterViews.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { kind, props, seq: ++seq, over, restore } } }));
}

export function closeCenterView(tabId: string): void {
  const open = useCenterViews.getState().byTab[tabId];
  if (!open) return;
  useCenterViews.setState((s) => {
    const byTab = { ...s.byTab };
    delete byTab[tabId];
    return { byTab };
  });
  if (open.restore) tabStore(tabId)?.getState().restoreSelection(open.restore);
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

/** What `open` makes of the left sidebar (`CenterViewOptions.sidebar`): `'hide'` while a view
 * that takes its place is open, on top or not; `'narrow'` while a file view is on top; else `null`. */
export function sidebarFor(open: Pick<OpenView, 'kind' | 'over'> | null, diff: DiffTarget | null): 'narrow' | 'hide' | null {
  if (!open) return null;
  const mode = optionsOf(open.kind).sidebar ?? 'narrow';
  if (mode === 'hide') return 'hide';
  return centerViewOnTop(open, diff) ? 'narrow' : null;
}

/** Stands in for a tab with no view store yet. */
const NO_STORE = createStore(() => ({ diff: null })) as unknown as RepoViewStore;

/** `sidebarFor` the tab's view, reactive. */
export function useCenterViewSidebar(tabId: string): 'narrow' | 'hide' | null {
  const open = useCenterView(tabId);
  const diff = useStore(useTabView(tabId)?.store ?? NO_STORE, (s) => s.diff);
  return sidebarFor(open, diff);
}

/** Whether the tab's view hides the left sidebar now (outside React): its actions stand aside. */
export const sidebarHidden = (tabId: string): boolean => sidebarFor(centerViewOf(tabId), tabStore(tabId)?.getState().diff ?? null) === 'hide';

/** UX R2.3: a click on the left sidebar's strip (its (>) or a panel's icon)
 * while a file view is on top closes the view, and the file it was opened over, so the sidebar
 * can expand. False when no file view was on top. */
export function leaveFileView(tabId: string): boolean {
  const store = tabStore(tabId);
  const open = centerViewOf(tabId);
  if (sidebarFor(open, store?.getState().diff ?? null) !== 'narrow') return false;
  closeCenterView(tabId);
  if (store?.getState().diff) store.getState().closeDiff();
  return true;
}

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
