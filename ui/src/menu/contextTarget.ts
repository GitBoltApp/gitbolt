import { useCallback, useEffect, useRef, useState } from 'react';
import { useMenu } from './menuStore';

/**
 * The row a context menu is open for (UX round 2): a right-click never changes a list's selection
 * (the graph, the sidebar, the file lists), so the row it was on gets a temporary "context"
 * outline instead, for as long as that menu stays open, as in VS Code.
 *
 * `open(key, show)` runs `show` (the row's `openContextMenu` call) and, if that put a new menu on
 * screen, marks `key` until the menu closes or another menu replaces it. `key` is null while no
 * menu of this list's is open.
 */
export function useContextTarget<K>(): [K | null, (key: K, show: () => void) => void] {
  const [key, setKey] = useState<K | null>(null);
  const unsub = useRef<(() => void) | null>(null);
  useEffect(() => () => unsub.current?.(), []);
  const open = useCallback((k: K, show: () => void) => {
    const before = useMenu.getState().seq;
    show();
    const opened = useMenu.getState();
    if (!opened.rows || opened.seq === before) return;
    unsub.current?.();
    setKey(() => k);
    const off = useMenu.subscribe((s) => {
      if (s.rows !== null && s.seq === opened.seq) return;
      off();
      if (unsub.current === off) unsub.current = null;
      setKey((cur) => (cur === k ? null : cur));
    });
    unsub.current = off;
  }, []);
  return [key, open];
}
