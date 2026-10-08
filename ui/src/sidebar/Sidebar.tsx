import { ChevronLeft } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useRepoContext } from '../app/repoContext';
import { useRuntime } from '../app/runtime';
import { useDiffOpen, useFocusZone } from '../app/seams1b';
import { EMPTY_REPO_SETTINGS, useAppState } from '../app/state';
import { leaveFileView, useCenterViewSidebar } from '../repo/centerView';
// --- 4B T11 ---
import { mrSection, refreshMrList, withMrSection } from '../forge/mrSection';
import { forgeOf, patchForge, useTabForgeField } from '../forge/mrStore';
// --- end 4B T11 ---
import { HoverTooltip } from '../ui/HoverTooltip';
import { onResetDoubleClick } from '../ui/resetHandle';
import { dividerTargets, layoutPanels } from './layout';
import { buildPanels, sectionKey, sectionsOf } from './model';
import { NarrowStrip } from './NarrowStrip';
import { PanelDivider } from './PanelDivider';
import { registerSidebarFilter } from './sidebarNav';
import { SidebarPanel } from './SidebarPanel';
import './sidebar.css';
import { displayChord } from '../ui/platformKeys';

const NO_WEIGHTS: Record<string, number> = {};
export const DEFAULT_SIDEBAR_W = 240;
const MIN_W = 160;
const MAX_W = 480;

/**
 * The left sidebar (spec §6.4): stacked panels (Local, Remote, Worktrees, Stashes, Tags), each
 * with its own header and virtualized body, sharing the column's height; dividers between
 * expanded panels resize them. One filter box filters every panel; a (<) button beside it
 * switches to the narrow icon strip. Panel collapse is per repo (`RepoSettings.collapsed`), sort
 * per panel per repo (`sidebarSort`); panel heights, the width and the narrow flag are per
 * profile. Narrow mode shows when the profile's own toggle (Ctrl+B) is set, or while the tab's
 * diff takeover is open (spec §6.4, §10.1) — the user is looking at a file, not the branch list,
 * so the sidebar steps out of the way without losing its state. A file view on top (File History,
 * Blame) narrows it too, and a click on the strip leaves the view for the graph (UX R2.3); the
 * rebase editor takes its place altogether while it's open (UX R2.1: nothing here may navigate
 * away from a plan).
 *
 * The hover card shows immediately on hover (no delay, the user's ruling): only its "Last push"
 * line waits on the backend, with its own loading placeholder.
 */
export function Sidebar() {
  const { tabId, repoId, path } = useRepoContext();
  const payload = useRuntime((s) => s.tabs[tabId]?.sidebar);
  const rs = useAppState((s) => s.profile.repos[path]) ?? EMPTY_REPO_SETTINGS;
  const width = useAppState((s) => s.profile.sidebarWidth);
  const manualNarrow = useAppState((s) => s.profile.sidebarNarrow);
  const weights = useAppState((s) => s.profile.sidebarPanels) ?? NO_WEIGHTS;
  const updateProfile = useAppState((s) => s.updateProfile);
  const updateRepo = useAppState((s) => s.updateRepo);
  const diffOpen = useDiffOpen(tabId);
  const viewSidebar = useCenterViewSidebar(tabId);
  const [filter, setFilter] = useState('');
  const [avail, setAvail] = useState(600);
  const filterRef = useRef<HTMLInputElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const panelEls = useRef(new Map<string, HTMLElement>());
  const bodyEls = useRef(new Map<string, HTMLDivElement>());
  const scrollTo = useRef<string | null>(null);
  const narrow = manualNarrow || diffOpen || viewSidebar === 'narrow';

  // --- 4B T11: the MR/PR section (spec #4 §2), after Remote, with the repository's filter ---
  const forgeKind = useTabForgeField(tabId, 'kind');
  const forgeList = useTabForgeField(tabId, 'list');
  const forgeFilter = useTabForgeField(tabId, 'filter');
  const forgeError = useTabForgeField(tabId, 'error');
  const mrs = useMemo(() => mrSection({ kind: forgeKind, list: forgeList, filter: forgeFilter, error: forgeError }), [forgeKind, forgeList, forgeFilter, forgeError]);
  const savedFilter = rs.mrFilter ?? 'all';
  useEffect(() => {
    if (forgeOf(tabId).filter === savedFilter) return;
    patchForge(tabId, { filter: savedFilter });
    void refreshMrList(tabId);
  }, [tabId, savedFilter]);
  // --- end 4B T11 ---

  const base = useMemo(() => (payload ? sectionsOf(payload) : null), [payload]);
  const sections = useMemo(() => (base ? withMrSection(base, mrs) : []), [base, mrs]); // 4B T11: a poll rebuilds only the MR/PR section
  const collapsed = useMemo(() => new Set(rs.collapsed), [rs.collapsed]);
  const panels = useMemo(() => buildPanels(sections, { filter, sort: rs.sidebarSort, collapsed }), [sections, filter, rs.sidebarSort, collapsed]);
  const specs = useMemo(() => panels.map((p) => ({ id: p.section.id, collapsed: p.collapsed, weight: weights[p.section.id] })), [panels, weights]);
  const heights = useMemo(() => layoutPanels(avail, specs), [avail, specs]);
  const targets = useMemo(() => dividerTargets(specs), [specs]);
  const zone = useFocusZone('sidebar', asideRef);

  useEffect(() => registerSidebarFilter(tabId, () => { filterRef.current?.focus(); filterRef.current?.select(); }), [tabId]);

  // The stack's height, which the expanded panels share.
  useLayoutEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const measure = () => { const h = Math.floor(parseFloat(getComputedStyle(el).height) || el.clientHeight); if (h > 0) setAvail(h); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [narrow]);

  // After the narrow strip's icon expanded the sidebar: bring that panel into view.
  useLayoutEffect(() => {
    const id = scrollTo.current;
    if (!id || narrow) return;
    scrollTo.current = null;
    panelEls.current.get(id)?.scrollIntoView?.({ block: 'nearest' });
  });

  const onPanelEl = useCallback((id: string, el: HTMLElement | null) => { if (el) panelEls.current.set(id, el); else panelEls.current.delete(id); }, []);
  const onBodyEl = useCallback((id: string, el: HTMLDivElement | null) => { if (el) bodyEls.current.set(id, el); else bodyEls.current.delete(id); }, []);
  const focusFirstBody = () => {
    const first = panels.find((p) => !p.collapsed);
    if (first) bodyEls.current.get(first.section.id)?.focus();
  };

  const commitPair = (i: number, j: number, upper: number, lower: number) =>
    updateProfile((p) => {
      const next = { ...p.sidebarPanels };
      panels.forEach((pn, k) => { if (!pn.collapsed) next[pn.section.id] = heights[k]; });
      next[panels[i].section.id] = upper;
      next[panels[j].section.id] = lower;
      return { ...p, sidebarPanels: next };
    });

  // A double-click on one divider resets just that divider (K73 fix): its two panels share their
  // combined height evenly again, the others keep theirs.
  const resetPair = (i: number, j: number) => {
    const total = heights[i] + heights[j];
    const upper = Math.round(total / 2);
    commitPair(i, j, upper, total - upper);
  };

  const pick = (id: string) => {
    leaveFileView(tabId);
    scrollTo.current = id;
    updateRepo(path, (r) => ({ ...r, collapsed: r.collapsed.filter((k) => k !== sectionKey(id)) }));
    updateProfile((p) => ({ ...p, sidebarNarrow: false }));
  };

  const resetWidth = () => updateProfile((p) => ({ ...p, sidebarWidth: DEFAULT_SIDEBAR_W }));

  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: PointerEvent) => updateProfile((p) => ({ ...p, sidebarWidth: Math.max(MIN_W, Math.min(MAX_W, Math.round(w0 + ev.clientX - x0))) }));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (viewSidebar === 'hide') return null;
  const expand = () => {
    leaveFileView(tabId);
    updateProfile((p) => ({ ...p, sidebarNarrow: false }));
  };
  if (narrow) return <NarrowStrip panels={panels} onExpand={expand} onPick={pick} />;

  return (
    <aside ref={asideRef} className="sidebar" style={{ width }} aria-label="Sidebar" {...zone}>
      <div className="sb-filter">
        <HoverTooltip content={`Collapse sidebar (${displayChord('Mod+B')})`}>
          <button type="button" className="sb-collapse" aria-label="Collapse sidebar" onClick={() => updateProfile((p) => ({ ...p, sidebarNarrow: true }))}><ChevronLeft size={14} /></button>
        </HoverTooltip>
        <input
          ref={filterRef}
          placeholder={`Filter (${displayChord('Mod+Alt+F')})`}
          aria-label="Filter branches"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setFilter(''); focusFirstBody(); }
            if (e.key === 'ArrowDown') { focusFirstBody(); e.preventDefault(); }
          }}
        />
      </div>
      <div ref={stackRef} className="sb-stack">
        {panels.map((panel, i) => {
          const j = targets[i];
          return (
            <SidebarPanel key={panel.section.id} panel={panel} height={heights[i]} tabId={tabId} repoId={repoId} path={path} onPanelEl={onPanelEl} onBodyEl={onBodyEl}>
              {j !== null && j !== undefined && (
                <PanelDivider
                  label={`Resize ${panel.section.label} and ${panels[j].section.label}`}
                  upperH={heights[i]}
                  lowerH={heights[j]}
                  getEls={() => [panelEls.current.get(panel.section.id) ?? null, panelEls.current.get(panels[j].section.id) ?? null]}
                  onCommit={(u, l) => commitPair(i, j, u, l)}
                  onReset={() => resetPair(i, j)}
                />
              )}
            </SidebarPanel>
          );
        })}
      </div>
      <div className="sb-resize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={0} onPointerDown={startResize} onKeyDown={(e) => { if (e.key === 'Enter') resetWidth(); }} {...onResetDoubleClick(resetWidth)} />
    </aside>
  );
}
