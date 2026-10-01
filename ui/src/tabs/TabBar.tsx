import { FolderPlus, X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { TabState } from '../api/gen/TabState';
import { runAction } from '../app/actions';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { activateTab, closeTab, moveTab, renameTab, tabLabel } from '../app/tabs';
import { openContextMenu } from '../menu/menuStore';
import { buildMenu } from '../menu/registry';
import { HoverTooltip } from '../ui/HoverTooltip';
import { isEditableTarget } from '../ui/keys';
import { HamburgerMenu } from './HamburgerMenu';
import { ProfileSwitcher } from './ProfileSwitcher';
import { nextTabFocus } from './tabKeyboard';
// The tab menu's contributions (`registerMenu`) register at import time.
import { useTabUi, type TabEnv, type TabTarget } from './tabMenu';
import { useTabDrag } from './useTabDrag';
import { isWindowBlur, refocusWhenWindowReturns } from '../ui/windowBlur';
import './tabs.css';

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

/** Spec §6.2: hamburger, the Open Repository folder icon, tabs (drag, rename, middle-click,
 * right-click menu), the profile switcher. The app shell's `header` slot. */
export function TabBar() {
  const tabs = useAppState((s) => s.profile.tabs);
  const active = useAppState((s) => s.profile.activeTab);
  const closedCount = useAppState((s) => s.profile.closedTabs.length);
  const runtimes = useRuntime((s) => s.tabs);
  const renaming = useTabUi((s) => s.renaming);
  const update = useAppState((s) => s.updateProfile);
  const { drag, onPointerDown, consumeClick } = useTabDrag((from, to) => update((p) => moveTab(p, from, to)));
  const tablistRef = useRef<HTMLDivElement>(null);

  /** Roving tabindex (spec §6.2): ArrowLeft/Right/Home/End move DOM focus among the tabs
   * (wrapping), without changing which one is active; Enter/Space activates the focused one.
   * Ctrl+Tab/Ctrl+Shift+Tab/Ctrl+PageUp/PageDown (global, `coreActions.ts`) are unaffected: they
   * aren't claimed here. */
  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, i: number, id: string) => {
    if (isEditableTarget(e.target)) return; // typing in the rename field
    const next = nextTabFocus(tabs.length, i, e.key);
    if (next !== null) {
      e.preventDefault();
      tablistRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      update((p) => activateTab(p, id));
    }
  };

  return (
    <div className="tab-bar">
      <HamburgerMenu />
      <HoverTooltip content="Open repository (Ctrl+O)">
        <button type="button" className="tab-bar-btn" aria-label="Open repository" onClick={() => runAction('file.openRepo')}>
          <FolderPlus size={16} aria-hidden />
        </button>
      </HoverTooltip>
      <div className="tabs" role="tablist" aria-label="Repositories" ref={tablistRef}>
        {tabs.map((t, i) => {
          const label = tabLabel(t, runtimes[t.id]?.repo?.name);
          const dragging = drag?.from === i;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === active}
              tabIndex={t.id === active ? 0 : -1}
              data-tab-id={t.id}
              className={`tab${dragging ? ' dragging' : ''}${drag && drag.to === i && !dragging ? ' drop-target' : ''}`}
              style={dragging ? { transform: `translateX(${drag.dx}px)` } : undefined}
              onPointerDown={(e) => { if (!isEditableTarget(e.target)) onPointerDown(e, i); }}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onClick={() => { if (!consumeClick()) update((p) => activateTab(p, t.id)); }}
              onAuxClick={(e) => { if (e.button === 1) update((p) => closeTab(p, t.id)); }}
              onDoubleClick={() => useTabUi.getState().startRename(t.id)}
              onContextMenu={(e) => openContextMenu(e, () => buildMenu<TabTarget, TabEnv>('tab', { tab: t, index: i }, { tabCount: tabs.length, closedCount }))}
              onKeyDown={(e) => onTabKeyDown(e, i, t.id)}
            >
              {renaming === t.id ? (
                <RenameInput tab={t} />
              ) : t.path ? (
                <HoverTooltip content={t.path} delayMs={400}>
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
                onClick={(e) => { e.stopPropagation(); update((p) => closeTab(p, t.id)); }}
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <ProfileSwitcher />
    </div>
  );
}
