import { useCallback, useEffect, useState } from 'react';
import { useMenu } from './menuStore';

/**
 * The row a context menu is open for (UX round 2): a right-click never changes a list's selection
 * (the graph, the sidebar, the file lists), so the row it was on gets a temporary "context"
 * outline instead, for as long as that menu stays open, as in VS Code.
 *
 * `open(key, show)` runs `show` (the row's `openContextMenu` call) and, if that put a new menu on
 * screen, marks `key` until the menu closes or another menu replaces it. `key` is null while no
 * menu of this list's is open.
 *
 * UX R1 C.3: the watch on the menu is an effect, so it's checked again whenever the list shows:
 * a list `<Activity>` hid meanwhile (the graph under a pick's merge tool or diff) has no effects
 * while hidden, and its menu may have closed then.
 */
export function useContextTarget<K>(): [K | null, (key: K, show: () => void) => void] {
  const [target, setTarget] = useState<{ key: K; seq: number } | null>(null);
  useEffect(() => {
    if (!target) return;
    const gone = (s: { rows: unknown; seq: number }) => s.rows === null || s.seq !== target.seq;
    const clear = () => setTarget((cur) => (cur === target ? null : cur));
    if (gone(useMenu.getState())) {
      clear();
      return;
    }
    return useMenu.subscribe((s) => { if (gone(s)) clear(); });
  }, [target]);
  const open = useCallback((k: K, show: () => void) => {
    const before = useMenu.getState().seq;
    show();
    const opened = useMenu.getState();
    if (!opened.rows || opened.seq === before) return;
    setTarget({ key: k, seq: opened.seq });
  }, []);
  return [target ? target.key : null, open];
}
