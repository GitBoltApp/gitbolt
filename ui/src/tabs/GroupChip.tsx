import { Check } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { TabGroup } from '../api/gen/TabGroup';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { activateTab, tabLabel } from '../app/tabs';
import { registerKeys } from '../ui/keyRouter';
import { chipEl, GROUP_LIST_DELAY_MS, groupLabel, useGroupUi } from './groupUi';

/** Moving between the chip and its list crosses no gap, but a leave and the next enter are two
 * events: the list closes only once the pointer has been off both this long. */
const LEAVE_GRACE_MS = 120;
let leaveTimer: number | undefined;
const cancelLeave = () => window.clearTimeout(leaveTimer);
function leaveSoon() {
  cancelLeave();
  leaveTimer = window.setTimeout(() => useGroupUi.getState().closeList(), LEAVE_GRACE_MS);
}

const insideList = (t: EventTarget | null) => t instanceof Node && !!document.querySelector('.tg-list')?.contains(t);

/**
 * A group's chip at its start in the tab strip: its name (or only its colour) on the group's
 * colour. A click collapses or expands the group, a drag moves the whole group (`onPointerDown`,
 * the strip's drag), a right-click or the menu key opens the group menu. Hovering it shows the
 * list of its tabs after the strip's hover delay; ArrowDown opens that list from the keyboard.
 */
export function GroupChip({ group, style, className, onPointerDown, onToggle, onKeyDown }: {
  group: TabGroup;
  style?: CSSProperties;
  className?: string;
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
  onToggle(): void;
  onKeyDown(e: ReactKeyboardEvent<HTMLElement>): void;
}) {
  const timer = useRef<number | undefined>(undefined);
  const pressed = useRef(false);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const label = groupLabel(group);
  return (
    <div
      role="button"
      tabIndex={-1}
      className={`tab-group-chip${group.collapsed ? ' collapsed' : ''}${className ? ` ${className}` : ''}`}
      data-strip-key={`chip:${group.id}`}
      data-group-color={group.color}
      aria-label={`Tab group: ${label}`}
      aria-expanded={!group.collapsed}
      aria-description={`${group.tabs.length} tab${group.tabs.length === 1 ? '' : 's'}`}
      style={style}
      onPointerDown={(e) => {
        window.clearTimeout(timer.current);
        if (e.button !== 0) return;
        // No list while pressed or dragged.
        pressed.current = true;
        window.addEventListener('pointerup', () => { pressed.current = false; }, { once: true });
        useGroupUi.getState().closeList();
        onPointerDown(e);
      }}
      onMouseEnter={() => {
        cancelLeave();
        if (pressed.current || useGroupUi.getState().list?.id === group.id) return;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => { if (!pressed.current) useGroupUi.getState().openList(group.id); }, GROUP_LIST_DELAY_MS);
      }}
      onMouseLeave={(e) => {
        window.clearTimeout(timer.current);
        if (!insideList(e.relatedTarget)) leaveSoon();
      }}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          useGroupUi.getState().openList(group.id, true);
          return;
        }
        onKeyDown(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        useGroupUi.getState().openMenu(group.id);
      }}
    >
      <span className="tg-chip-pill">{group.name && <span className="tg-chip-name">{group.name}</span>}</span>
    </div>
  );
}

/**
 * The chip's list of its tabs (Firefox's): one row per tab, by the name the strip shows, the
 * active one checked. A row switches to its tab; a collapsed group stays collapsed, since the
 * strip shows the active tab even then. Under the chip; it stays while the pointer is on the chip
 * or the list. From the keyboard: ↑/↓ (Home/End) move, Enter or Space switches, Esc goes back to
 * the chip.
 */
export function GroupTabList({ group, focus }: { group: TabGroup; focus: boolean }) {
  const tabs = useAppState((s) => s.profile.tabs);
  const active = useAppState((s) => s.profile.activeTab);
  const runtimes = useRuntime((s) => s.tabs);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const rows = group.tabs.map((id) => tabs.find((t) => t.id === id)).filter((t) => t !== undefined);
  const label = groupLabel(group);

  useLayoutEffect(() => {
    const r = chipEl(group.id)?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(4, r.left), top: r.bottom - 1 });
  }, [group.id]);
  useEffect(() => {
    if (focus) ref.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
  }, [focus]);

  useEffect(() => {
    const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const close = (backToChip: boolean) => {
      useGroupUi.getState().closeList();
      if (backToChip) chipEl(group.id)?.focus();
    };
    return registerKeys('menu', (e) => {
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        close(at >= 0);
        return 'handled';
      }
      if (at < 0) {
        // Shown by the pointer: a key isn't for it (and the list goes, so the next one reaches the app).
        close(false);
        return;
      }
      const go = (i: number) => { e.preventDefault(); list[(i + list.length) % list.length]?.focus(); return 'handled' as const; };
      if (e.key === 'ArrowDown') return go(at + 1);
      if (e.key === 'ArrowUp') return go(at - 1);
      if (e.key === 'Home') return go(0);
      if (e.key === 'End') return go(list.length - 1);
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        list[at].click();
        return 'handled';
      }
      if (e.key === 'Tab') close(true);
      return 'handled';
    });
  }, [group.id]);

  return createPortal(
    <div
      ref={ref}
      className="tg-list"
      role="menu"
      aria-label={`Tabs in ${label}`}
      data-group-color={group.color}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      onMouseEnter={cancelLeave}
      onMouseLeave={(e) => { if (!(e.relatedTarget instanceof Node && chipEl(group.id)?.contains(e.relatedTarget))) leaveSoon(); }}
    >
      {rows.map((t) => {
        const name = tabLabel(t, runtimes[t.id]?.repo?.name);
        return (
          <div
            key={t.id}
            role="menuitemradio"
            aria-checked={t.id === active}
            tabIndex={-1}
            className="tg-list-row"
            onClick={() => {
              useAppState.getState().updateProfile((p) => activateTab(p, t.id));
              useGroupUi.getState().closeList();
            }}
          >
            <Check size={12} aria-hidden className="tg-list-check" />
            <span className="tg-list-name">{name}</span>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
