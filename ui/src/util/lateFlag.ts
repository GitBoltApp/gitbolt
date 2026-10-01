import { useEffect, useState } from 'react';

/** How long something may take to load or compute before its thin progress line shows (the diff
 * header's, the file list's "View all files"). */
export const BUSY_DELAY_MS = 150;

/** True once `on` has held for `ms` for the same `key`; false again as soon as it drops. */
export function useLateFlag(on: boolean, ms: number, key: string): boolean {
  const [late, setLate] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setLate(key), ms);
    return () => clearTimeout(timer);
  }, [on, ms, key]);
  return on && late === key;
}
