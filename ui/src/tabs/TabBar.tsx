import { FolderPlus, Settings, X } from 'lucide-react';
import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Profile } from '../api/gen/Profile';
import type { TabState } from '../api/gen/TabState';
import { runAction } from '../app/actions';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { guardTabClose } from '../diff/workingCopy';
import { groupById, groupOf, groupOnto, moveGroup, placeTab, stripItems, toggleGroupCollapsed, type Place, type StripItem } from '../app/tabGroups';
import { activateTab, closeTab, renameTab, tabLabel } from '../app/tabs';
import { openContextMenu } from '../menu/menuStore';
import { buildMenu } from '../menu/registry';
import { HoverTooltip } from '../ui/HoverTooltip';
import { isEditableTarget } from '../ui/keys';
import { GroupChip, GroupTabList } from './GroupChip';
import { GroupLines, type LineSpec } from './GroupLines';
import { GroupMenu } from './GroupMenu';
import { GROUP_LIST_DELAY_MS, useGroupUi } from './groupUi';
import { HamburgerMenu } from './HamburgerMenu';
import { NotificationsBell } from './NotificationsBell';
import { ProfileSwitcher } from './ProfileSwitcher';
import { nextTabFocus } from './tabKeyboard';
// The tab menu's contributions (`registerMenu`) register at import time.
import { useTabUi, type TabBarEnv, type TabEnv, type TabTarget } from './tabMenu';
import { tabDragRange, tabDropAt, unitLocator, useTabDrag, type DragBox, type DragPlan, type DropPreview, type TabDrop } from './useTabDrag';
import { isWindowBlur, refocusWhenWindowReturns } from '../ui/windowBlur';
import './tabs.css';
import { displayChord } from '../ui/platformKeys';

function RenameInput({ tab }: { tab: TabState }) {
  const stop = useTabUi((s) => s.stopRename);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.select(); }, []);
  // Enter commits, Esc cancels, a blur (a click outside) commits; only the first of them counts
  // (unmounting the focused input can blur it once more).
  const commit = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    if (value !== null) useAppState.getState().updateProfile((p) => renameTab(p, tab.id, value));
    stop();
  };
  return (
    <input
      ref={ref}
      className="tab-rename"
      aria-label="Tab name"
      defaultValue={tab.alias ?? ''}
      // The input is the tab's child: its presses and clicks are the caret's, not the tab's
      // (no tab switch, no drag start, no rename restart on a double-click to select a word).
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation(); // the tab strip's roving keys (arrows, Home/End, Space) aren't for the text
        if (e.key === 'Enter') commit(e.currentTarget.value);
        if (e.key === 'Escape') commit(null);
      }}
      onBlur={(e) => {
        // The window losing focus (the WM's focus bounce on every press under GNOME) isn't a click
        // outside: keep editing, caret back once the window returns (K41).
        if (isWindowBlur()) return refocusWhenWindowReturns(e.currentTarget, () => !done.current);
        commit(e.currentTarget.value);
      }}
    />
  );
}

const itemKey = (i: StripItem) => (i.kind === 'chip' ? `chip:${i.group.id}` : `tab:${i.tab.id}`);
const keysOf = (p: Profile) => stripItems(p).map(itemKey);

/**
 * Dragging the shown tab `tabId` among the strip's items (`tabDropAt`): into a group past its chip
 * or between its tabs, out of one once its middle is past the group's edge, onto an ungrouped
 * tab's middle to make a group of the two. A collapsed group is passed whole. A release is one
 * update, whatever it leaves and joins.
 */
function tabPlan(p: Profile, tabId: string, update: (fn: (p: Profile) => Profile) => void): DragPlan {
  const own = groupOf(p, tabId)?.id ?? null;
  const entries: { keys: string[]; kind: DragBox['kind']; group: string | null; tab?: string }[] = [];
  for (const item of stripItems(p)) {
    const whole = !!item.group?.collapsed && item.group.id !== own;
    if (whole && item.kind === 'tab') entries.at(-1)!.keys.push(itemKey(item));
    else if (item.kind === 'chip') entries.push({ keys: [itemKey(item)], kind: whole ? 'block' : 'chip', group: item.group.id });
    else entries.push({ keys: [itemKey(item)], kind: 'tab', group: item.group?.id ?? null, tab: item.tab.id });
  }
  const from = entries.findIndex((e) => e.tab === tabId);
  const others = entries.filter((_, i) => i !== from);
  const members = (id: string) => (groupById(p, id)?.tabs ?? []).filter((t) => t !== tabId);
  /** A slot in the model's terms: beside a tab, past a group's last tab, or (null) where it is. */
  const place = (gap: number, group: string | null): Place | null => {
    const prev = others[gap - 1];
    const next = others[gap];
    if (group) return prev?.tab ? { after: prev.tab } : next?.tab ? { before: next.tab } : null;
    if (prev?.group) {
      const last = members(prev.group).at(-1);
      return last ? { after: last } : null;
    }
    if (prev?.tab) return { after: prev.tab };
    const first = next && (next.tab ?? members(next.group!)[0]);
    return first ? { before: first } : null;
  };
  const preview = (drop: TabDrop): DropPreview => {
    if ('onto' in drop) {
      const target = entries[drop.onto].tab!;
      const q = groupOnto(p, tabId, target, 'preview');
      return { order: keysOf(q), color: groupOf(q, tabId)?.color ?? null, group: null, onto: `tab:${target}`, commit: () => update((x) => groupOnto(x, tabId, target)) };
    }
    if (drop.gap === from && drop.group === own) return { order: keysOf(p), color: groupOf(p, tabId)?.color ?? null, group: own, onto: null, commit: null };
    const at = place(drop.gap, drop.group);
    const q = placeTab(p, tabId, at, drop.group);
    return { order: keysOf(q), color: groupOf(q, tabId)?.color ?? null, group: groupOf(q, tabId)?.id ?? null, onto: null, commit: () => update((x) => placeTab(x, tabId, at, drop.group)) };
  };
  return {
    moving: [`tab:${tabId}`],
    locate: (m) => {
      if (from < 0 || !entries.every((e) => e.keys.every((k) => k in m.lefts))) return null;
      const boxes = entries.map((e): DragBox => {
        const left = m.lefts[e.keys[0]];
        const width = e.keys.reduce((s, k) => s + m.widths[k], 0);
        return e.kind === 'tab' ? { kind: 'tab', group: e.group, left, width } : e.kind === 'chip' ? { kind: 'chip', group: e.group!, left, width } : { kind: 'block', left, width };
      });
      const cache = new Map<string, DropPreview>();
      // The zone last previewed: held a little past its edge (hysteresis).
      let held: TabDrop | undefined;
      return {
        ...tabDragRange(boxes, from, m.stripLeft, m.stripRight),
        at: (dx) => {
          const drop = tabDropAt(boxes, from, dx, held);
          held = drop;
          const k = JSON.stringify(drop);
          if (!cache.has(k)) cache.set(k, preview(drop));
          return cache.get(k)!;
        },
      };
    },
  };
}

/** Dragging group `id` by its chip: it moves as a block among the ungrouped tabs and the other
 * groups, never into one. */
function groupPlan(p: Profile, id: string, update: (fn: (p: Profile) => Profile) => void): DragPlan {
  const units: { keys: string[]; first: string; last: string; group?: string }[] = [];
  for (const item of stripItems(p)) {
    if (item.kind === 'chip') units.push({ keys: [itemKey(item)], first: item.group.tabs[0], last: item.group.tabs.at(-1)!, group: item.group.id });
    else if (item.group) units.at(-1)!.keys.push(itemKey(item));
    else units.push({ keys: [itemKey(item)], first: item.tab.id, last: item.tab.id });
  }
  const from = units.findIndex((u) => u.group === id);
  const place = (to: number): Place => (to > from ? { after: units[to].last } : { before: units[to].first });
  const color = groupById(p, id)?.color ?? null;
  return {
    moving: units[from]?.keys ?? [],
    locate: (m) => (from < 0 ? null : unitLocator(units.map((u) => u.keys), from, m,
      (to) => ({ order: keysOf(to === from ? p : moveGroup(p, id, place(to))), color, group: id }),
      (to) => update((q) => moveGroup(q, id, place(to))))),
  };
}

/** Spec §6.2: hamburger, the Open Repository folder icon, tabs (drag, rename, middle-click,
 * right-click menu) and their groups (chips), the profile switcher. The app shell's `header`
 * slot. */
export function TabBar() {
  const profile = useAppState((s) => s.profile);
  const { tabs, activeTab: active, tabGroups } = profile;
  const closedCount = profile.closedTabs.length;
  const lastClosed = profile.closedTabs.at(-1) ?? null;
  const runtimes = useRuntime((s) => s.tabs);
  const renaming = useTabUi((s) => s.renaming);
  const menuGroup = useGroupUi((s) => (s.menu ? tabGroups.find((g) => g.id === s.menu) ?? null : null));
  const list = useGroupUi((s) => s.list);
  const listGroup = list ? tabGroups.find((g) => g.id === list.id) ?? null : null;
  const update = useAppState((s) => s.updateProfile);
  const { drag, onPointerDown, consumeClick, itemStyle, slotWindow } = useTabDrag();
  const tablistRef = useRef<HTMLDivElement>(null);
  // A collapsed group's tabs stay laid out at no width, so collapsing and expanding animate.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the strip depends on these three only
  const items = useMemo(() => stripItems(profile, true), [tabs, tabGroups, active]);

  /** Roving tabindex (spec §6.2): ArrowLeft/Right/Home/End move DOM focus among the tabs and the
   * group chips (wrapping), without changing which one is active; Enter/Space activates the
   * focused tab. Ctrl+Tab/Ctrl+Shift+Tab/Ctrl+PageUp/PageDown (global, `coreActions.ts`) are
   * unaffected: they aren't claimed here. */
  const rove = (e: ReactKeyboardEvent<HTMLElement>): boolean => {
    const stops = [...(tablistRef.current?.querySelectorAll<HTMLElement>('[role="tab"], .tab-group-chip') ?? [])];
    const next = nextTabFocus(stops.length, stops.indexOf(e.currentTarget), e.key);
    if (next === null) return false;
    e.preventDefault();
    stops[next]?.focus();
    return true;
  };
  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, id: string) => {
    if (isEditableTarget(e.target)) return; // typing in the rename field
    if (rove(e)) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      update((p) => activateTab(p, id));
    }
  };

  const dragged = (key: string) => !!drag?.moving.includes(key);
  // Each group's line, its tabs as a drag previews them: the dragged tab the ghost of the group it
  // would land in (easing in and out of its line), or with the tab it would be dropped onto (the
  // group that makes). A group dragged by its chip keeps its line above its lifted items.
  const draggedTab = drag?.moving.length === 1 && drag.moving[0].startsWith('tab:') ? drag.moving[0].slice(4) : null;
  const lineSpecs: LineSpec[] = tabGroups.map((g) => ({
    id: g.id, color: g.color, chip: g.id,
    tabs: g.tabs.filter((id) => id !== draggedTab),
    ghost: draggedTab && drag!.group === g.id ? draggedTab : null,
    lifted: !!drag?.moving.includes(`chip:${g.id}`),
  }));
  if (draggedTab && drag!.onto && drag!.color) lineSpecs.push({ id: 'drop-onto', color: drag!.color, chip: null, tabs: [draggedTab, drag!.onto.slice(4)], lifted: true });
  const lifted = (key: string) => (dragged(key) ? ` lifted${drag!.phase === 'drag' ? ' dragging' : ''}` : '');

  return (
    <div className="tab-bar">
      <HamburgerMenu />
      <HoverTooltip content={`Open repository (${displayChord('Mod+O')})`}>
        <button type="button" className="tab-bar-btn" aria-label="Open repository" onClick={() => runAction('file.openRepo')}>
          <FolderPlus size={16} aria-hidden />
        </button>
      </HoverTooltip>
      <div className={`tabs${drag ? ' reordering' : ''}`} role="tablist" aria-label="Repositories" ref={tablistRef}
        // Empty space only: a tab's own menu stops its event. The menu key and Shift+F10 reach this
        // too, as a native contextmenu event on whatever has focus.
        onContextMenu={(e) => openContextMenu(e, () => buildMenu<null, TabBarEnv>('tabbar', null, { lastClosed, savedGroups: useAppState.getState().profile.savedGroups }))}
        // Empty space only, as a browser's tab strip: a new tab on the Open repository screen.
        onDoubleClick={(e) => { if (e.target === e.currentTarget) runAction('file.openRepo'); }}
      >
        {items.map((item) => {
          const key = itemKey(item);
          if (item.kind === 'chip') {
            const g = item.group;
            return (
              <GroupChip
                key={key}
                group={g}
                className={lifted(key).trim() || undefined}
                style={itemStyle(key)}
                onPointerDown={(e) => onPointerDown(e, () => groupPlan(useAppState.getState().profile, g.id, update))}
                onToggle={() => { if (!consumeClick()) update((p) => toggleGroupCollapsed(p, g.id)); }}
                onKeyDown={(e) => { rove(e); }}
              />
            );
          }
          const t = item.tab;
          const label = tabLabel(t, runtimes[t.id]?.repo?.name);
          // The group border a drag previews ("sticky") on the dragged tab and the tab it would be
          // dropped onto, through the slide that settles it; else the tab's own group's.
          const color = drag && (dragged(key) || drag.onto === key) ? drag.color : item.group?.color ?? null;
          const index = tabs.indexOf(t);
          const { hidden } = item;
          return (
            <div
              key={key}
              role={hidden ? undefined : 'tab'}
              aria-selected={hidden ? undefined : t.id === active}
              aria-hidden={hidden || undefined}
              inert={hidden || undefined}
              tabIndex={t.id === active ? 0 : -1}
              data-tab-id={t.id}
              data-strip-key={hidden ? undefined : key}
              data-group-color={color ?? undefined}
              className={`tab${color ? ' grouped' : ''}${hidden ? ' tab-hidden' : ''}${drag?.onto === key ? ' drop-onto' : ''}${lifted(key)}`}
              style={itemStyle(key)}
              onPointerDown={(e) => { if (!isEditableTarget(e.target)) onPointerDown(e, () => tabPlan(useAppState.getState().profile, t.id, update)); }}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onClick={() => { if (!consumeClick()) update((p) => activateTab(p, t.id)); }}
              onAuxClick={(e) => { if (e.button === 1) guardTabClose([t.id], () => update((p) => closeTab(p, t.id))); }}
              onDoubleClick={() => useTabUi.getState().startRename(t.id)}
              onContextMenu={(e) => openContextMenu(e, () => buildMenu<TabTarget, TabEnv>('tab', { tab: t, index }, { tabCount: tabs.length, closedCount }))}
              onKeyDown={(e) => onTabKeyDown(e, t.id)}
            >
              {renaming === t.id ? (
                <RenameInput tab={t} />
              ) : t.path ? (
                <HoverTooltip content={t.path} delayMs={GROUP_LIST_DELAY_MS}>
                  <span className="tab-label">{label}</span>
                </HoverTooltip>
              ) : (
                <span className="tab-label">{label}</span>
              )}
              <button
                type="button"
                className="tab-close"
                // Not in the roving tab order (the one active tab is the strip's only Tab stop);
                // closing by keyboard goes through Ctrl+W, not tabbing to this button.
                tabIndex={-1}
                aria-label={`Close ${label}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); guardTabClose([t.id], () => update((p) => closeTab(p, t.id))); }}
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          );
        })}
        <GroupLines strip={tablistRef} specs={lineSpecs} moving={!!drag} slotWindow={slotWindow} />
      </div>
      {menuGroup && <GroupMenu key={menuGroup.id} group={menuGroup} />}
      {listGroup && !drag && <GroupTabList key={listGroup.id} group={listGroup} focus={list!.focus} />}
      <NotificationsBell />
      <HoverTooltip content={`Settings (${displayChord('Mod+,')})`}>
        <button type="button" className="tab-bar-btn" aria-label="Settings" onClick={() => runAction('file.settings')}>
          <Settings size={16} aria-hidden />
        </button>
      </HoverTooltip>
      <ProfileSwitcher />
    </div>
  );
}
