import { Clock, TriangleAlert } from 'lucide-react';
import { relativeTime } from '../format/relative';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useTabForge, type TabForge } from './mrStore';

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "Couldn't refresh: <reason>. Last updated 2 minutes ago" (spec #4 §6: stale data stays,
 * with a note), "Rate limited until 14:05. …" while the account's budget is spent, or "Updated
 * 2 hours ago" while what's shown is the last session's (until the first poll answers); null
 * when the last poll worked. */
export function staleText(f: TabForge, now = Date.now()): string | null {
  const ago = (ms: number) => relativeTime(ms / 1000, now / 1000);
  const updated = f.updatedAt ? ` Last updated ${ago(f.updatedAt)}` : '';
  if (f.limitedUntil !== null && f.limitedUntil > now) return `Rate limited until ${hhmm(f.limitedUntil)}.${updated}`;
  if (f.error) return `Couldn't refresh: ${f.error}.${updated}`;
  return f.cachedAt !== null ? `Updated ${ago(f.cachedAt)}` : null;
}

/** The sidebar section header's warning. */
export function ForgeStaleIcon({ tabId }: { tabId: string }) {
  const f = useTabForge(tabId);
  const text = staleText(f);
  if (!text) return null;
  // Not a failure (a limit's wait, the last session's data): a clock, not a warning.
  const limited = !f.error;
  return (
    <HoverTooltip content={text}>
      <span className="forge-stale" role="img" aria-label={text}>{limited ? <Clock size={12} aria-hidden /> : <TriangleAlert size={12} aria-hidden />}</span>
    </HoverTooltip>
  );
}

/** The MR/PR view's line. */
export function ForgeStaleNote({ tabId }: { tabId: string }) {
  const text = staleText(useTabForge(tabId));
  return text ? <p className="forge-stale-note" role="status">{text}</p> : null;
}
