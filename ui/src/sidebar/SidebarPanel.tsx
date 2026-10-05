import { PendingMark } from '../pending/PendingMark';
import { usePendingAny } from '../pending/store';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Clock, Folder, FolderOpen, GitBranch, House, ListTree, Tag, TreePine } from 'lucide-react';
import { stashLabel } from './stashLabel';
import { memo, useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { selectCommit } from '../app/graphNav';
import { useAppState } from '../app/state';
import { useRuntime } from '../app/runtime';
import { RemoteFetchWarning } from './RemoteFetchWarning';
import { RemoteIcon } from '../icons/brands';
import { StashIcon } from '../icons/stash';
import { sidebarItemMenu, sidebarRemoteMenu } from '../menu/menuEnv';
import { openContextMenu, type MenuEventLike } from '../menu/menuStore';
import { useContextTarget } from '../menu/contextTarget';
import { useRepoViewStore } from '../repo/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useToast } from '../ui/toast';
import { HoverCard } from './HoverCard';
import { HEADER_H, ROW_H, rowIndent } from './layout';
import { sectionKey, type FlatRow, type Panel, type SideItem } from './model';
import { useHeaderActions, sidebarDoubleClick, type HeaderAction } from './itemActions';
import { SectionIcon } from './SectionIcon';
import { UpstreamWarning } from '../branches/UpstreamWarning';
// --- 4B T10 ---
import { LocalBranchBadge } from '../forge/MrBadge';
// --- end 4B T10 ---
// --- 4B T11 ---
import { PipelineIcon } from '../forge/MrIcons';
import { pipelineText } from '../forge/mrText';

/** The pipeline states an MR/PR row shows an icon for. */
const NOTABLE_PIPELINE = new Set(['failed', 'running', 'pending']);
import { openMrView } from '../forge/poll';
import { MrFilterButton } from '../forge/MrFilterButton';
import { ForgeStaleIcon } from '../forge/ForgeStale';
import { RemoteLookupWarning, RemoteMainChip } from './RemoteForgeMarks';
import { useForge, useTabForgeField } from '../forge/mrStore';
// --- end 4B T11 ---

const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

export function ItemIcon({ item, tabId }: { item: SideItem; tabId: string }) {
  const pending = usePendingAny(tabId, [item.kind === 'local' || item.kind === 'remote' ? item.branch.fullName : null]);
  if (pending) return <PendingMark action={pending} />;
  if (item.kind === 'local') return item.branch.isHead ? <span className="co-check" aria-label="current branch"><Check size={11} strokeWidth={3} /></span> : <GitBranch size={13} />;
  if (item.kind === 'remote') return <GitBranch size={13} />;
  if (item.kind === 'mr') return null; // the section says what these are; a draft's label is dimmed
  if (item.kind === 'worktree') {
    const Icon = item.worktree.isMain ? House : TreePine;
    return <Icon size={13} data-wt={item.worktree.isMain ? 'main' : 'linked'} aria-label={item.worktree.isCurrent ? 'current worktree' : undefined} aria-hidden={item.worktree.isCurrent ? undefined : true} />;
  }
  if (item.kind === 'stash') return <StashIcon size={13} />;
  // UX round 3, M.2: an annotated tag's icon is filled, a lightweight one's outlined.
  return item.tag.annotation ? <Tag size={13} fill="currentColor" aria-label="annotated tag" /> : <Tag size={13} />;
}

/**
 * One stacked sidebar panel (spec §6.4): a header (chevron, icon, NAME, count, sort) and, when
 * expanded, its own virtualized tree body with its own keyboard cursor. `height` comes from the
 * stack's layout; the divider (`children`) sits on its bottom edge. Collapse state and sort are
 * per repo (`RepoSettings.collapsed` / `sidebarSort`), as they were before panels.
 */
// --- 2C T9: header actions ---
const NO_ACTIONS: HeaderAction[] = [];
// --- end 2C T9 ---

export const SidebarPanel = memo(function SidebarPanel({ panel, height, tabId, repoId, path, onPanelEl, onBodyEl, children }: {
  panel: Panel;
  height: number;
  tabId: string;
  repoId: number;
  path: string;
  /** Stable registrars: the stack keeps each panel's and body's element (direct-DOM drag, focus, scroll-to). */
  onPanelEl: (id: string, el: HTMLElement | null) => void;
  onBodyEl: (id: string, el: HTMLDivElement | null) => void;
  children?: ReactNode;
}) {
  const { section, rows, collapsed } = panel;
  const updateRepo = useAppState((s) => s.updateRepo);
  const headerActions = useHeaderActions((s) => s.bySection[section.id] ?? NO_ACTIONS);
  const store = useRepoViewStore();
  const fetchErrors = useRuntime((s) => s.tabs[tabId]?.remoteFetchErrors);
  const mainRemote = useTabForgeField(tabId, 'target');
  const mainChosen = useTabForgeField(tabId, 'targetChosen');
  const mainKind = useTabForgeField(tabId, 'kind');
  const lookupErrors = useTabForgeField(tabId, 'remoteErrors');
  const [cursor, setCursor] = useState(0);
  // An MR/PR section's selection is the open view's MR/PR (null in the other sections).
  const openMr = useForge((s) => (section.kind === 'mrs' ? s.byTab[tabId]?.openMr ?? null : null));
  const [hover, setHover] = useState<{ item: SideItem; top: number; left: number } | null>(null);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const id = panel.section.id;
  const setPanelRef = useCallback((el: HTMLElement | null) => onPanelEl(id, el), [onPanelEl, id]);
  const setBodyRef = useCallback((el: HTMLDivElement | null) => { setBody(el); onBodyEl(id, el); }, [onBodyEl, id]);
  const bodyH = Math.max(0, height - HEADER_H);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => body, estimateSize: () => ROW_H, overscan: 10, initialRect: { width: 240, height: bodyH } });

  useEffect(() => { setCursor((c) => Math.min(c, Math.max(0, rows.length - 1))); }, [rows.length]);

  useEffect(() => {
    if (openMr === null) return;
    const i = rows.findIndex((r) => r.type === 'item' && r.item.kind === 'mr' && r.item.mr.number === openMr);
    if (i >= 0) setCursor(i);
  }, [openMr, rows]);

  const jump = (item: SideItem, focus = false) => {
    // --- 4B T11: an MR/PR row opens its view ---
    if (item.kind === 'mr') {
      openMrView(tabId, item.mr.number);
      return;
    }
    // --- end 4B T11 ---
    if (!item.target || !selectCommit(tabId, item.target, { focus })) useToast.getState().show('Not in the loaded history');
  };
  const flip = (key: string) => updateRepo(path, (r) => ({ ...r, collapsed: toggle(r.collapsed, key) }));
  const activate = (row: FlatRow, focus = false) => (row.type === 'item' ? jump(row.item, focus) : flip(row.key));
  const setOpen = (row: FlatRow, open: boolean) => {
    if (row.type === 'item' || row.collapsed === !open) return false;
    flip(row.key);
    return true;
  };
  const moveTo = (i: number) => {
    const c = Math.max(0, Math.min(rows.length - 1, i));
    setCursor(c);
    v.scrollToIndex(c, { align: 'auto' });
    // In the MR/PR list the selection is the open view: moving it opens that row's.
    const r = rows[c];
    if (section.kind === 'mrs' && r?.type === 'item' && r.item.kind === 'mr' && c !== cursor) openMrView(tabId, r.item.mr.number, 'replace');
  };
  /** The row's context menu (spec §7): a branch, tag, stash, worktree or MR/PR item, or a remote's folder. */
  const menuOf = (row: FlatRow | undefined) => {
    if (!row) return null;
    if (row.type === 'item') return sidebarItemMenu(store, row.item, tabId);
    return row.remote && section.kind === 'remote' ? sidebarRemoteMenu(store, row.remote) : null;
  };
  // A right-click never moves the active row (UX round 2): the row it was on gets the temporary
  // `data-context` outline while its menu is open instead.
  const [contextKey, openContextFor] = useContextTarget<string>();
  const onRowMenu = (e: MenuEventLike, row: FlatRow) => {
    const build = menuOf(row);
    if (build) openContextFor(row.key, () => openContextMenu(e, build));
    else e.preventDefault();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[cursor];
    // The menu key and Shift+F10: the active row's menu, below that row.
    if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const build = menuOf(row);
      if (!build) return;
      const at = (body?.querySelector('[data-active="true"]') ?? body)?.getBoundingClientRect();
      openContextMenu({ preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation(), clientX: at?.left ?? 0, clientY: at?.bottom ?? 0, timeStamp: performance.now() }, build);
      return;
    }
    const page = Math.max(1, Math.floor((body?.clientHeight ?? 240) / ROW_H) - 1);
    const handled = (() => {
      switch (e.key) {
        case 'ArrowDown': moveTo(cursor + 1); return true;
        case 'ArrowUp': moveTo(cursor - 1); return true;
        case 'Home': moveTo(0); return true;
        case 'End': moveTo(rows.length - 1); return true;
        case 'PageDown': moveTo(cursor + page); return true;
        case 'PageUp': moveTo(cursor - page); return true;
        // Enter moves the keyboard to the graph with the selection (spec §11.1); the graph's own
        // Up/Down don't wrap, so the sidebar doesn't either (no spec call for it here).
        case 'Enter': case ' ': if (row) activate(row, true); return true;
        case 'ArrowLeft': return row ? setOpen(row, false) : false;
        case 'ArrowRight': return row ? setOpen(row, true) : false;
        default: return false;
      }
    })();
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };
  const onItemEnter = (item: SideItem, el: HTMLElement) => {
    const aside = el.closest('.sidebar')?.getBoundingClientRect().right ?? 240;
    setHover({ item, top: el.getBoundingClientRect().top, left: aside + 6 });
  };

  const sortLabel = `Sort ${section.label}: ${panel.sort}`;
  return (
    <section ref={setPanelRef} className={`sb-panel${collapsed ? ' is-collapsed' : ''}`} aria-label={section.label} data-panel={section.id} style={{ height }}>
      <div className="sb-panel-head" style={{ height: HEADER_H - 1 }}>
        <button type="button" className="sb-panel-toggle" aria-label={section.label} aria-expanded={!collapsed} onClick={() => flip(sectionKey(section.id))}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <SectionIcon section={section} />
          <span className="sb-label">{section.label}</span>
          <span className="sb-count" aria-label={`${section.label} count`}>{panel.matched}</span>
        </button>
        {/* --- 2C T9: section header actions (the Worktrees header's +) --- */}
        {headerActions.map((a) => (
          <HoverTooltip key={a.id} content={a.label}>
            <button type="button" className="icon-button sb-head-action" aria-label={a.label} onClick={(e) => { e.stopPropagation(); a.run({ tabId }); }}>
              <a.icon size={13} aria-hidden />
            </button>
          </HoverTooltip>
        ))}
        {/* --- end 2C T9 --- */}
        {/* --- 4B T11: the MR/PR section's warning and filter --- */}
        {section.kind === 'mrs' && <ForgeStaleIcon tabId={tabId} />}
        {section.kind === 'mrs' && <MrFilterButton tabId={tabId} path={path} />}
        {/* --- end 4B T11 --- */}
        {section.nests && !collapsed && (
          <HoverTooltip content={panel.sort === 'tree' ? 'Sorted as a directory tree. Click: newest first' : 'Newest first. Click: directory tree'}>
            <button type="button" className="icon-button sb-sort" aria-label={sortLabel} onClick={() => updateRepo(path, (r) => ({ ...r, sidebarSort: { ...r.sidebarSort, [section.id]: panel.sort === 'tree' ? 'recent' : 'tree' } }))}>
              {panel.sort === 'tree' ? <ListTree size={12} /> : <Clock size={12} />}
            </button>
          </HoverTooltip>
        )}
      </div>
      {!collapsed && (
        <div
          ref={setBodyRef}
          className="sb-list"
          role="tree"
          aria-label={`${section.label} items`}
          tabIndex={0}
          data-keep-flyout-focus={section.kind === 'mrs' ? '' : undefined}
          onKeyDown={onKey}
        >
          {rows.length === 0 && <div className="sb-empty">{panel.filtering ? 'No matches' : section.empty ?? 'Nothing here'}</div>}
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              if (!row) return null;
              const active = vi.index === cursor;
              const indent = { paddingLeft: rowIndent(row.depth) };
              const style = { transform: `translateY(${vi.start}px)`, height: ROW_H, ...indent };
              if (row.type === 'folder') {
                return (
                  <div key={row.key} role="treeitem" aria-level={row.depth} aria-expanded={!row.collapsed} data-active={active} data-context={row.key === contextKey || undefined} className="sb-row sb-folder" style={style} onClick={() => { setCursor(vi.index); activate(row); }} onContextMenu={(e) => onRowMenu(e, row)}>
                    {row.remote ? <RemoteIcon kind={row.hostKind ?? 'generic'} host={row.host} remote={row.remote} size={13} tabId={tabId} /> : row.collapsed ? <Folder size={13} /> : <FolderOpen size={13} />}
                    <span className="sb-label">{row.name}</span>
                    {row.remote && fetchErrors?.[row.remote] && <RemoteFetchWarning remote={row.remote} {...fetchErrors[row.remote]!} />}
                    {row.remote && section.kind === 'remote' && row.remote === mainRemote && <RemoteMainChip remote={row.remote} kind={mainKind} chosen={mainChosen} />}
                    {row.remote && lookupErrors[row.remote] && <RemoteLookupWarning remote={row.remote} reason={lookupErrors[row.remote]!} />}
                  </div>
                );
              }
              const it = row.item;
              const head = (it.kind === 'local' && it.branch.isHead) || (it.kind === 'worktree' && it.worktree.isCurrent);
              return (
                <div
                  key={row.key}
                  role="treeitem"
                  aria-level={row.depth}
                  aria-label={it.kind === 'stash' ? `stash@{${it.stash.index}}: ${it.name}` : it.name}
                  data-active={active}
                  aria-selected={section.kind === 'mrs' ? it.kind === 'mr' && it.mr.number === openMr : undefined}
                  data-context={row.key === contextKey || undefined}
                  data-kind={it.kind}
                  className={`sb-row sb-item${head ? ' is-head' : ''}`}
                  style={style}
                  onClick={(e) => { setCursor(vi.index); if (it.kind === 'mr') (e.currentTarget.closest('.sb-list') as HTMLElement | null)?.focus({ preventScroll: true }); jump(it); }}
                  onDoubleClick={() => { sidebarDoubleClick({ tabId, store }, it); }}
                  onPointerEnter={(e) => onItemEnter(it, e.currentTarget)}
                  onPointerLeave={() => setHover(null)}
                  onContextMenu={(e) => { setHover(null); onRowMenu(e, row); }}
                >
                  <ItemIcon item={it} tabId={tabId} />
                  {/* UX round 3, M.1: an upstream with another branch name, before the name. */}
                  {it.kind === 'local' && it.branch.upstreamMismatch && <UpstreamWarning branch={it.name} upstream={it.branch.upstreamMismatch} size={13} />}
                  <span className="sb-label" title={it.kind === 'stash' ? `stash@{${it.stash.index}}` : undefined} data-draft={it.kind === 'mr' && it.mr.state === 'draft' ? '' : undefined}>{it.kind === 'stash' ? <StashText label={row.label} /> : row.label}</span>
                  {it.kind === 'local' && (it.branch.ahead > 0 || it.branch.behind > 0) && <span className="sb-ab" aria-label={`${it.branch.ahead} ahead, ${it.branch.behind} behind`}><span>{it.branch.ahead}<ArrowUp size={12} strokeWidth={2.5} aria-hidden /></span><span>{it.branch.behind}<ArrowDown size={12} strokeWidth={2.5} aria-hidden /></span></span>}
                  {/* --- 4B T10: the branch's MR/PR badge (spec #4 §5) --- */}
                  {it.kind === 'local' && <LocalBranchBadge tabId={tabId} upstream={it.branch.upstream} />}
                  {/* --- end 4B T10 --- */}
                  {/* --- 4B T11: an MR/PR row's pipeline, only when it needs a look (failed, running, pending); the hover card says the rest --- */}
                  {it.kind === 'mr' && it.mr.pipeline && NOTABLE_PIPELINE.has(it.mr.pipeline.status) && <span className="sb-pipeline" role="img" aria-label={pipelineText(it.forge, it.mr.pipeline)}><PipelineIcon pipeline={it.mr.pipeline} size={12} /></span>}
                  {/* --- end 4B T11 --- */}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {children}
      {hover && <HoverCard item={hover.item} repoId={repoId} top={hover.top} left={hover.left} />}
    </section>
  );
});

function StashText({ label }: { label: string }) {
  const { text, branch } = stashLabel(label);
  return <>{text}{branch && <span className="sb-dim"> {branch}</span>}</>;
}
