import { TriangleAlert } from 'lucide-react';
import { relativeTime } from '../format/relative';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useTabForge, type TabForge } from './mrStore';

/** "Couldn't refresh: <reason>. Last updated 2 minutes ago" (spec #4 §6: stale data stays,
 * with a note); null when the last poll worked. */
export function staleText(f: TabForge, now = Date.now()): string | null {
  if (!f.error) return null;
  return `Couldn't refresh: ${f.error}.${f.updatedAt ? ` Last updated ${relativeTime(f.updatedAt / 1000, now / 1000)}` : ''}`;
}

/** The sidebar section header's warning. */
export function ForgeStaleIcon({ tabId }: { tabId: string }) {
  const text = staleText(useTabForge(tabId));
  if (!text) return null;
  return (
    <HoverTooltip content={text}>
      <span className="forge-stale" role="img" aria-label={text}><TriangleAlert size={12} aria-hidden /></span>
    </HoverTooltip>
  );
}

/** The MR/PR view's line. */
export function ForgeStaleNote({ tabId }: { tabId: string }) {
  const text = staleText(useTabForge(tabId));
  return text ? <p className="forge-stale-note" role="status">{text}</p> : null;
}
