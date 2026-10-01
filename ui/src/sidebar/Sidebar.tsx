import { useVirtualizer } from '@tanstack/react-virtual';
import { Archive, Check, ChevronDown, ChevronRight, Clock, Folder, FolderTree, GitBranch, Laptop, ListTree, Tag } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { selectCommit } from '../app/graphNav';
import { useRepoContext } from '../app/repoContext';
import { useRuntime } from '../app/runtime';
import { useDiffOpen, useFocusZone } from '../app/seams1b';
import { EMPTY_REPO_SETTINGS, useAppState } from '../app/state';
import { RemoteIcon } from '../icons/brands';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useToast } from '../ui/toast';
import { HoverCard } from './HoverCard';
import { buildRows, sectionsOf, type FlatRow, type SideItem } from './model';
import { NarrowStrip } from './NarrowStrip';
import { registerSidebarFilter } from './sidebarNav';
import './sidebar.css';

const ROW_H = 24;
const MIN_W = 160;
const MAX_W = 480;

const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

function SectionIcon({ row }: { row: Extract<FlatRow, { type: 'section' }> }) {
  const s = row.section;
  if (s.kind === 'local') return <Laptop size={13} />;
  if (s.kind === 'remote') return <RemoteIcon kind={s.hostKind ?? 'generic'} remote={s.label} size={13} />;
  if (s.kind === 'worktrees') return <FolderTree size={13} />;
  if (s.kind === 'stashes') return <Archive size={13} />;
  return <Tag size={13} />;
}

function ItemIcon({ item }: { item: SideItem }) {
  if (item.kind === 'local') return item.branch.isHead ? <Check size={13} aria-label="current branch" /> : <GitBranch size={13} />;
  if (item.kind === 'remote') return <GitBranch size={13} />;
  if (item.kind === 'worktree') return <span className={`wt-dot${item.worktree.isCurrent ? ' current' : ''}`} aria-label={item.worktree.isCurrent ? 'current worktree' : undefined} />;
  if (item.kind === 'stash') return <Archive size={13} />;
  return <Tag size={13} />;
}

/**
 * The left sidebar (spec §6.4): Local/remote branches, Worktrees, Stashes and Tags, filterable
 * and sortable, with a resize handle and a narrow (icon-strip) mode. Its collapse state is per
 * repo (`RepoSettings.collapsed`), its sort per section per repo (`sidebarSort`); its width and
 * narrow flag are per profile. Narrow mode shows when the profile's own toggle (Ctrl+B) is set,
 * or while the tab's diff takeover is open (spec §6.4, §10.1) — the user is looking at a file,
 * not the branch list, so the sidebar steps out of the way without losing its state.
 *
 * The hover card shows immediately on hover (no delay, the user's ruling): only its "Last push"
 * line waits on the backend, with its own loading placeholder.
 *
 * Sidebar item context menus are a later wave (Task 15b): rows carry everything a menu builder
 * would need (`row.item`'s `kind` and payload) but wire nothing yet, so there's no `onContextMenu`
 * here to remove when they land — just one to add, next to the item's `onClick` below.
 */
export function Sidebar() {
  const { tabId, repoId, path } = useRepoContext();
  const payload = useRuntime((s) => s.tabs[tabId]?.sidebar);
  const rs = useAppState((s) => s.profile.repos[path]) ?? EMPTY_REPO_SETTINGS;
  const width = useAppState((s) => s.profile.sidebarWidth);
  const manualNarrow = useAppState((s) => s.profile.sidebarNarrow);
  const updateProfile = useAppState((s) => s.updateProfile);
  const updateRepo = useAppState((s) => s.updateRepo);
  const diffOpen = useDiffOpen(tabId);
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);
  const [hover, setHover] = useState<{ item: SideItem; top: number } | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);

  const sections = useMemo(() => (payload ? sectionsOf(payload) : []), [payload]);
  const collapsed = useMemo(() => new Set(rs.collapsed), [rs.collapsed]);
  const rows = useMemo(() => buildRows(sections, { filter, sort: rs.sidebarSort, collapsed }), [sections, filter, rs.sidebarSort, collapsed]);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => listRef.current, estimateSize: () => ROW_H, overscan: 10, initialRect: { width, height: 600 } });
  const zone = useFocusZone('sidebar', asideRef);

  useEffect(() => registerSidebarFilter(tabId, () => { filterRef.current?.focus(); filterRef.current?.select(); }), [tabId]);
  useEffect(() => { setCursor((c) => Math.min(c, Math.max(0, rows.length - 1))); }, [rows.length]);

  const jump = (item: SideItem, focus = false) => {
    if (!item.target || !selectCommit(tabId, item.target, { focus })) useToast.getState().show('Not in the loaded history');
  };
  const activate = (row: FlatRow, focus = false) => {
    if (row.type === 'item') jump(row.item, focus);
    else updateRepo(path, (r) => ({ ...r, collapsed: toggle(r.collapsed, row.key) }));
  };
  const setOpen = (row: FlatRow, open: boolean) => {
    if (row.type === 'item' || row.collapsed === !open) return false;
    updateRepo(path, (r) => ({ ...r, collapsed: toggle(r.collapsed, row.key) }));
    return true;
  };
  const moveTo = (i: number) => {
    const c = Math.max(0, Math.min(rows.length - 1, i));
    setCursor(c);
    v.scrollToIndex(c, { align: 'auto' });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[cursor];
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 240) / ROW_H) - 1);
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
    if (item.kind === 'worktree') return;
    setHover({ item, top: el.getBoundingClientRect().top });
  };
  const onItemLeave = () => setHover(null);

  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: PointerEvent) => updateProfile((p) => ({ ...p, sidebarWidth: Math.max(MIN_W, Math.min(MAX_W, Math.round(w0 + ev.clientX - x0))) }));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (manualNarrow || diffOpen) return <NarrowStrip sections={sections} onExpand={() => updateProfile((p) => ({ ...p, sidebarNarrow: false }))} />;

  return (
    <aside ref={asideRef} className="sidebar" style={{ width }} aria-label="Sidebar" {...zone}>
      <div className="sb-filter">
        <input
          ref={filterRef}
          placeholder="Filter (Ctrl+Alt+F)"
          aria-label="Filter branches"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setCursor(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setFilter(''); listRef.current?.focus(); }
            if (e.key === 'ArrowDown') { listRef.current?.focus(); e.preventDefault(); }
          }}
        />
      </div>
      <div ref={listRef} className="sb-list" role="tree" aria-label="Branches, worktrees, stashes and tags" tabIndex={0} onKeyDown={onKey}>
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            const style = { transform: `translateY(${vi.start}px)`, height: ROW_H };
            const active = vi.index === cursor;
            if (row.type === 'section') {
              return (
                <div key={row.key} role="treeitem" aria-expanded={!row.collapsed} aria-level={1} data-active={active} className="sb-row sb-section" style={style} onClick={() => { setCursor(vi.index); activate(row); }}>
                  {row.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <SectionIcon row={row} />
                  <span className="sb-label">{row.section.label}</span>
                  <span className="sb-count" aria-label={`${row.section.label} count`}>{row.filtering ? `${row.matched}/${row.total}` : row.total}</span>
                  {row.section.nests && (
                    <HoverTooltip content={row.sort === 'tree' ? 'Sorted as a folder tree. Click: newest first' : 'Newest first. Click: folder tree'}>
                      <button type="button" className="icon-button sb-sort" aria-label={`Sort ${row.section.label}: ${row.sort}`} onClick={(e) => { e.stopPropagation(); updateRepo(path, (r) => ({ ...r, sidebarSort: { ...r.sidebarSort, [row.section.id]: row.sort === 'tree' ? 'recent' : 'tree' } })); }}>
                        {row.sort === 'tree' ? <ListTree size={12} /> : <Clock size={12} />}
                      </button>
                    </HoverTooltip>
                  )}
                </div>
              );
            }
            const indent = { paddingLeft: 8 + row.depth * 14 };
            if (row.type === 'folder') {
              return (
                <div key={row.key} role="treeitem" aria-expanded={!row.collapsed} data-active={active} className="sb-row sb-folder" style={{ ...style, ...indent }} onClick={() => { setCursor(vi.index); activate(row); }}>
                  {row.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <Folder size={13} />
                  <span className="sb-label">{row.name}</span>
                </div>
              );
            }
            const it = row.item;
            const head = it.kind === 'local' && it.branch.isHead;
            return (
              <div
                key={row.key}
                role="treeitem"
                aria-label={it.kind === 'stash' ? `stash@{${it.stash.index}}: ${it.name}` : it.name}
                data-active={active}
                data-kind={it.kind}
                className={`sb-row sb-item${head ? ' is-head' : ''}`}
                style={{ ...style, ...indent }}
                onClick={() => { setCursor(vi.index); jump(it); }}
                onPointerEnter={(e) => onItemEnter(it, e.currentTarget)}
                onPointerLeave={onItemLeave}
                // Sidebar item context menus (Task 15b): commitMenu/labelMenu wire an
                // onContextMenu here, keyed off `it` (its kind and payload), next to onClick.
              >
                <ItemIcon item={it} />
                <span className="sb-label">{it.kind === 'stash' ? `stash@{${it.stash.index}}: ${row.label}` : row.label}</span>
                {it.kind === 'local' && (it.branch.ahead > 0 || it.branch.behind > 0) && <span className="sb-ab">{it.branch.ahead}↑ {it.branch.behind}↓</span>}
              </div>
            );
          })}
        </div>
      </div>
      <div className="sb-resize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" onPointerDown={startResize} />
      {hover && <HoverCard item={hover.item} repoId={repoId} top={hover.top} left={(asideRef.current?.getBoundingClientRect().right ?? width) + 6} />}
    </aside>
  );
}
