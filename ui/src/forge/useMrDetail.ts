import { useEffect } from 'react';
import type { ForgeMrDetail } from '../api/gen/ForgeMrDetail';
import { useForge } from './mrStore';
import { loadMrDetail } from './poll';

/** An MR/PR's detail for a hover card. It asks after one frame of grace, as the sidebar's hover
 * card does: a card the pointer only swept past sends nothing. */
export function useMrDetail(tabId: string, number: number): { detail: ForgeMrDetail | null; error: string | null } {
  const detail = useForge((s) => s.byTab[tabId]?.details[number]?.value ?? null);
  const error = useForge((s) => s.byTab[tabId]?.detailErrors[number] ?? null);
  useEffect(() => {
    const raf = requestAnimationFrame(() => { void loadMrDetail(tabId, number); });
    return () => cancelAnimationFrame(raf);
  }, [tabId, number]);
  return { detail, error };
}
