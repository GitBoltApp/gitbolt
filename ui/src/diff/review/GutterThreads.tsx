import { Check } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import { ForgeAvatar } from '../../avatars/Avatar';
import { hideTooltip, showTooltip } from '../../ui/tooltipStore';
import './review.css';

const firstLine = (s: string) => s.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';

/** "Resolved thread by Grace Hopper: Why this line?", and how many more fold there. */
export function gutterTip(threads: readonly ForgeDiscussion[]): string {
  const d = threads[0]!;
  const first = d.notes.find((n) => !n.system);
  const what = `${d.resolved ? 'Resolved thread' : 'Thread'} by ${first?.author.name ?? 'someone'}`;
  const excerpt = first ? firstLine(first.body) : '';
  const more = threads.length - 1;
  return `${what}${excerpt && `: ${excerpt}`}${more > 0 ? ` (and ${more} more ${more === 1 ? 'thread' : 'threads'})` : ''}`;
}

/**
 * The folded threads at a line of the source diff (review mode), in the glyph margin
 * (`ReviewZones`' icon, rendered into through a portal): the first thread's author's avatar, as
 * GitLab shows a collapsed thread, with a check on a resolved one and a count when several fold
 * there. The icon's node handles its press and keys (it's in Monaco's element, whose own handling
 * must not see them); this is what it shows, its tooltip and its name.
 */
export function GutterThreads({ threads, size }: { threads: readonly ForgeDiscussion[]; size: number }) {
  const d = threads[0]!;
  const author = d.notes.find((n) => !n.system)?.author;
  const tip = gutterTip(threads);
  const shown = useRef(false);
  // Unfolded under the pointer, the icon goes with no mouseleave: its tooltip goes with it.
  useEffect(() => () => { if (shown.current) hideTooltip(); }, []);
  if (!author) return null;
  return (
    <button
      type="button"
      tabIndex={-1}
      className="review-gutter-thread"
      data-review-focus=""
      data-resolved={d.resolved || undefined}
      aria-label={`Expand: ${tip}`}
      onMouseEnter={(e) => { shown.current = true; showTooltip(e.currentTarget, tip, 0, 'right'); }}
      onMouseLeave={() => { shown.current = false; hideTooltip(); }}
    >
      <ForgeAvatar user={author} size={size} />
      {d.resolved && <span className="review-gutter-check" aria-hidden><Check size={Math.max(7, Math.round(size * 0.4))} strokeWidth={3.5} /></span>}
      {threads.length > 1 && <span className="review-gutter-count" aria-hidden>{threads.length}</span>}
    </button>
  );
}
