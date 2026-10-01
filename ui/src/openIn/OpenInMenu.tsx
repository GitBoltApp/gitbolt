import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import { openMenuAt, refreshMenuOn, useMenu } from '../menu/menuStore';
import { useRepoView, type DiffTarget } from '../repo/store';
import { openerIcon, openerRowId, openInSubmenuRows } from './openerRows';
import { defaultOpener, listWorktree, openerLabel, openersSnapshot, openVersion, refreshOpeners, subscribeOpeners, useOpenIn, useOpeners, worktreeOf } from './openers';
import './openIn.css';

// Rebuilds an open Open-in dropdown when the openers change (fix round 1, item 2: an R1
// regression of H32 — this module doesn't import menu/menuEnv.ts, which has its own copy of this
// subscription for the file menu's Open in ▸ submenu, so it needs its own). Harmless if both are
// loaded: `refresh()` is a no-op unless this dropdown is the open menu.
const offOpeners = refreshMenuOn(subscribeOpeners);
import.meta.hot?.dispose(() => offOpeners());

/** An opener's icon: the same one the file menu's Open in ▸ submenu shows (`openerIcon`). */
export function OpenerIcon({ opener, size = 14 }: { opener: OpenerPayload; size?: number }) {
  const Icon = openerIcon(opener);
  return <Icon size={size} aria-hidden />;
}

/**
 * "Open in <default>" plus a dropdown of every opener (feedback H9), for the diff header's
 * `leading` slot. Opens `target`'s file at `line`, as the file list does: in a WIP (staged too)
 * or compare-with-working-tree list, the working-tree file of that list's `worktree` (given, or
 * read from the target's key); elsewhere the version shown, in the repo's worktree. "Show in
 * Files" uses the same worktree. The default is the opener used last (shared with the file
 * list's menu), else VS Code. Renders nothing until the openers have loaded, or when none were
 * found.
 *
 * Plan 1C Task 15 (Amendment 11): the dropdown is the shared context menu (`openMenuAt` +
 * `openInSubmenuRows`, the same rows the file menu's Open in ▸ submenu builds), not a bespoke
 * popup — `ContextMenu` already does its positioning, focus and keyboard handling. `expanded` is
 * tracked locally (the menu store is one singleton shared by every menu, so it can't say *this*
 * button opened it) and cleared whenever the store closes, however that happened.
 */
export function OpenInButton({ target, line = null, worktree: given }: { target: DiffTarget; line?: number | null; worktree?: string | null }) {
  const openers = useOpeners();
  const repoPath = useRepoView((s) => s.repoPath);
  const { last, open } = useOpenIn();
  const [expanded, setExpanded] = useState(false);
  const group = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  // Fix round 1, item 3: a press on the toggle while its own dropdown is open must close it, not
  // reopen it at the same place (`ContextMenu`'s own outside-press dismiss already closes it by
  // the time the `click` fires; without this, `show()` would just reshow it). `pointerdown` runs
  // before that dismiss's state update is applied (React 18 batches it), so `expanded` here is
  // still last render's value — the one from just before this press.
  const wasOpen = useRef(false);
  const current = openers ? defaultOpener(openers, last) : null;
  useEffect(() => useMenu.subscribe((s) => { if (s.rows === null) setExpanded(false); }), []);
  if (!openers || !current) return null;
  const worktree = given ?? listWorktree(target.key) ?? worktreeOf(target);
  const t = { worktree: worktree ?? repoPath, path: target.path, line, ...openVersion(target, worktree) };
  const copy = t.source.kind === 'object' || t.source.kind === 'atCommit';
  const build = () => openInSubmenuRows(openersSnapshot().list, openersSnapshot().error, (o) => open(o, t), { copy });
  const show = () => {
    refreshOpeners().catch(() => {});
    setExpanded(true);
    // From the toggle's own rect, not the whole group: `placeMenu`'s flip-above (no room below)
    // must clear the toggle, not just the group's (here, same) bottom edge.
    openMenuAt(toggle.current!, build(), openerRowId(current), build, 'Open in');
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
        aria-expanded={expanded}
        onPointerDown={() => { wasOpen.current = expanded; }}
        onClick={() => { if (!wasOpen.current) show(); }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' || expanded) return;
          e.preventDefault();
          show();
        }}
      >
        <ChevronDown size={12} aria-hidden />
      </button>
    </span>
  );
}
