import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Clock, Folder, FolderOpen, GitBranch, House, ListTree, Tag, TreePine } from 'lucide-react';
import { stashLabel } from './stashLabel';
import { memo, useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { selectCommit } from '../app/graphNav';
import { useAppState } from '../app/state';
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

const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

function ItemIcon({ item }: { item: SideItem }) {
  if (item.kind === 'local') return item.branch.isHead ? <span className="co-check" aria-label="current branch"><Check size={11} strokeWidth={3} /></span> : <GitBranch size={13} />;
  if (item.kind === 'remote') return <GitBranch size={13} />;
  if (item.kind === 'worktree') {
    const Icon = item.worktree.isMain ? House : TreePine;
    return <Icon size={13} data-wt={item.worktree.isMain ? 'main' : 'linked'} aria-label={item.worktree.isCurrent ? 'current worktree' : undefined} aria-hidden={item.worktree.isCurrent ? undefined : true} />;
  }
  if (item.kind === 'stash') return <StashIcon size={13} />;
  return <Tag size={13} />;
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
  const [cursor, setCursor] = useState(0);
  const [hover, setHover] = useState<{ item: SideItem; top: number; left: number } | null>(null);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const id = panel.section.id;
  const setPanelRef = useCallback((el: HTMLElement | null) => onPanelEl(id, el), [onPanelEl, id]);
  const setBodyRef = useCallback((el: HTMLDivElement | null) => { setBody(el); onBodyEl(id, el); }, [onBodyEl, id]);
  const bodyH = Math.max(0, height - HEADER_H);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => body, estimateSize: () => ROW_H, overscan: 10, initialRect: { width: 240, height: bodyH } });

  useEffect(() => { setCursor((c) => Math.min(c, Math.max(0, rows.length - 1))); }, [rows.length]);

  const jump = (item: SideItem, focus = false) => {
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
  };
  /** The row's context menu (spec §7): a branch, tag, stash or worktree item, or a remote's folder. */
  const menuOf = (row: FlatRow | undefined) => {
    if (!row) return null;
    if (row.type === 'item') return sidebarItemMenu(store, row.item);
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
        {section.nests && !collapsed && (
          <HoverTooltip content={panel.sort === 'tree' ? 'Sorted as a folder tree. Click: newest first' : 'Newest first. Click: folder tree'}>
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
          onKeyDown={onKey}
        >
          {rows.length === 0 && <div className="sb-empty">{panel.filtering ? 'No matches' : 'Nothing here'}</div>}
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
                    {row.remote ? <RemoteIcon kind={row.hostKind ?? 'generic'} host={row.host} remote={row.remote} size={13} /> : row.collapsed ? <Folder size={13} /> : <FolderOpen size={13} />}
                    <span className="sb-label">{row.name}</span>
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
                  data-context={row.key === contextKey || undefined}
                  data-kind={it.kind}
                  className={`sb-row sb-item${head ? ' is-head' : ''}`}
                  style={style}
                  onClick={() => { setCursor(vi.index); jump(it); }}
                  onDoubleClick={() => { sidebarDoubleClick({ tabId, store }, it); }}
                  onPointerEnter={(e) => onItemEnter(it, e.currentTarget)}
                  onPointerLeave={() => setHover(null)}
                  onContextMenu={(e) => { setHover(null); onRowMenu(e, row); }}
                >
                  <ItemIcon item={it} />
                  <span className="sb-label" title={it.kind === 'stash' ? `stash@{${it.stash.index}}` : undefined}>{it.kind === 'stash' ? <StashText label={row.label} /> : row.label}</span>
                  {it.kind === 'local' && (it.branch.ahead > 0 || it.branch.behind > 0) && <span className="sb-ab" aria-label={`${it.branch.ahead} ahead, ${it.branch.behind} behind`}><span>{it.branch.ahead}<ArrowUp size={12} strokeWidth={2.5} aria-hidden /></span><span>{it.branch.behind}<ArrowDown size={12} strokeWidth={2.5} aria-hidden /></span></span>}
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
