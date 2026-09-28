import { ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import { useRepoView, type DiffTarget } from '../repo/store';
import { openerIcon, openerRows } from './openerRows';
import { defaultOpener, listWorktree, openerLabel, openVersion, refreshOpeners, useOpenIn, useOpeners, worktreeOf } from './openers';
import './openIn.css';

const EDGE = 8;

/** An opener's icon: the same one the file menu's Open in ▸ submenu shows (`openerIcon`). */
export function OpenerIcon({ opener, size = 14 }: { opener: OpenerPayload; size?: number }) {
  const Icon = openerIcon(opener);
  return <Icon size={size} aria-hidden />;
}

/** Why a menu closed: Escape and Tab give focus back to where the menu came from; a press
 * elsewhere leaves it where the press put it (the press already moved focus itself). A scroll or
 * a resize (`'dismiss'`, I2) gives focus back too, but only when it's still on the menu: neither
 * moves focus on its own, so without that the menu hiding would otherwise drop focus to
 * `<body>`. */
export type MenuCloseReason = 'escape' | 'tab' | 'outside' | 'dismiss';

/**
 * The "Open in…" menu (feedback H9): one item per opener, at `at` (viewport px; kept inside the
 * window; when it doesn't fit below, it ends at `above`, the anchor's top, so it never covers the
 * control it came from), portaled so no panel clips it. `openers` is `null` while they load: the
 * menu shows at once with a loading row (or `error`'s row) and fills in when they arrive, focus
 * moving to the default only if it's still on the menu. Focus starts on `current` (the default
 * opener). Up/Down (wrapping), Home/End move; Enter or Space picks; Escape, Tab, a press outside
 * it (other than on `anchor`, the control that toggles it), a scroll or a resize close it. Keys
 * never reach the lists behind it.
 */
export function OpenInMenu({ openers: list, error = null, current = null, at, above = at.y, onPick, onClose, anchor }: {
  openers: OpenerPayload[] | null;
  error?: string | null;
  current?: string | null;
  at: { x: number; y: number };
  above?: number;
  onPick: (o: OpenerPayload) => void;
  onClose: (reason: MenuCloseReason) => void;
  anchor?: RefObject<HTMLElement | null>;
}) {
  const openers = list ?? [];
  const ref = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(EDGE, Math.min(at.x, window.innerWidth - EDGE - width))}px`;
    el.style.top = `${Math.max(EDGE, at.y + height > window.innerHeight - EDGE ? above - height : at.y)}px`;
  }, [at, above, list, error]);

  // Focus: the default item, or the menu itself until there are items. When they arrive, focus
  // moves to the default only if it's still on the menu (never taken from elsewhere).
  const loaded = list !== null;
  const tookFocus = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || (tookFocus.current && document.activeElement !== el)) return;
    tookFocus.current = true;
    const start = Math.max(0, openers.findIndex((o) => o.id === current));
    (items.current[start] ?? el).focus({ preventScroll: true });
    // Decided on opening, and again only when the list first arrives.
  }, [loaded]);

  useEffect(() => {
    const inside = (t: EventTarget | null) => t instanceof Node && (ref.current?.contains(t) || anchor?.current?.contains(t));
    // I2: a scroll or a resize dismisses the menu; refocus the toggle only if focus is still on
    // the menu itself (not, say, a pick's own focus move already in flight).
    const stillFocused = () => !!ref.current && ref.current.contains(document.activeElement);
    const onDown = (e: MouseEvent) => { if (!inside(e.target)) onCloseRef.current('outside'); };
    const onAway = (e: Event) => { if (!(e.target instanceof Node && ref.current?.contains(e.target))) onCloseRef.current(stillFocused() ? 'dismiss' : 'outside'); };
    const onResize = () => onCloseRef.current(stillFocused() ? 'dismiss' : 'outside');
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onAway, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onAway, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor]);

  const onKeyDown = (e: KeyboardEvent) => {
    // The menu is portaled, but React still bubbles its keys to the tree it's rendered from
    // (the file list, the view's Escape handler): none of them may act on a menu key.
    e.stopPropagation();
    const n = openers.length;
    const i = items.current.findIndex((b) => b === document.activeElement);
    const focus = (j: number) => items.current[((j % n) + n) % n]?.focus();
    switch (e.key) {
      case 'ArrowDown': focus(i + 1); break;
      case 'ArrowUp': focus(i < 0 ? n - 1 : i - 1); break;
      case 'Home': focus(0); break;
      case 'End': focus(n - 1); break;
      case 'Enter':
      case ' ':
        if (i >= 0) onPick(openers[i]);
        break;
      case 'Escape': onClose('escape'); break;
      case 'Tab': onClose('tab'); break;
      default: return;
    }
    e.preventDefault();
  };

  return createPortal(
    <div ref={ref} role="menu" aria-label="Open in" tabIndex={-1} className="open-in-menu" style={{ left: at.x, top: at.y }} onKeyDown={onKeyDown} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {list === null && <div className="open-in-empty" role="status">{error ? `Couldn't list editors: ${error}` : 'Looking for editors…'}</div>}
      {list !== null && openers.length === 0 && <div className="open-in-empty">No editor or file manager found</div>}
      {/* The same rows (label, icon, action) as the file menu's Open in ▸ submenu. */}
      {openerRows(openers, onPick).map((row, i) => (
        <button key={row.id} ref={(b) => { items.current[i] = b; }} type="button" role="menuitem" tabIndex={-1} className="open-in-item" data-opener={openers[i].id} onClick={row.run}>
          <row.icon size={14} aria-hidden />
          <span>{row.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

/**
 * "Open in <default>" plus a dropdown of every opener (feedback H9), for the diff header's
 * `leading` slot. Opens `target`'s file at `line`, as the file list does: in a WIP (staged too)
 * or compare-with-working-tree list, the working-tree file of that list's `worktree` (given, or
 * read from the target's key); elsewhere the version shown, in the repo's worktree. "Show in
 * Files" uses the same worktree. The default is the opener used last (shared with the file
 * list's menu), else VS Code. Renders nothing until the openers have loaded, or when none were
 * found.
 */
export function OpenInButton({ target, line = null, worktree: given }: { target: DiffTarget; line?: number | null; worktree?: string | null }) {
  const openers = useOpeners();
  const repoPath = useRepoView((s) => s.repoPath);
  const { last, open } = useOpenIn();
  const [menu, setMenu] = useState<{ x: number; y: number; above: number } | null>(null);
  const group = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const current = openers ? defaultOpener(openers, last) : null;
  if (!openers || !current) return null;
  const worktree = given ?? listWorktree(target.key) ?? worktreeOf(target);
  const t = { worktree: worktree ?? repoPath, path: target.path, line, ...openVersion(target, worktree) };
  const show = () => {
    refreshOpeners().catch(() => {});
    const r = group.current!.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 2, above: r.top - 2 });
  };
  const close = (refocus: boolean) => {
    setMenu(null);
    if (refocus) toggle.current?.focus();
  };
  return (
    <span ref={group} className="open-in-button" role="group" aria-label="Open in">
      <button type="button" className="open-in-main" data-opener={current.id} onClick={() => open(current, t)}>
        <OpenerIcon opener={current} />
        <span>{openerLabel(current)}</span>
      </button>
      <button
        ref={toggle}
        type="button"
        className="open-in-toggle"
        aria-label="More ways to open"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => (menu ? close(false) : show())}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' || menu) return;
          e.preventDefault();
          show();
        }}
      >
        <ChevronDown size={12} aria-hidden />
      </button>
      {menu && (
        <OpenInMenu
          openers={openers}
          current={current.id}
          at={menu}
          above={menu.above}
          anchor={toggle}
          onPick={(o) => {
            close(true);
            open(o, t);
          }}
          onClose={(reason) => close(reason !== 'outside')}
        />
      )}
    </span>
  );
}
