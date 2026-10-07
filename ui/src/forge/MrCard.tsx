import type { ReactNode } from 'react';
import type { ForgeKind } from '../api/gen/ForgeKind';
import type { ForgeMr } from '../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../api/gen/ForgeMrDetail';
import { ForgeAvatar } from '../avatars/Avatar';
import { EmojiText } from './emoji';
import { mrName, mrRef } from './labels';
import { MrStateChip, PipelineIcon } from './MrIcons';
import { ArrowGlyph } from '../ui/ArrowGlyph';
import { branchesParts, pipelineText, reviewText } from './mrText';

/**
 * The hover card's body (spec #4 §4 "4B"): state chip, number and title, the author, the branches, then
 * only what needs a look: a pipeline, a review state, conflicts (never "No reviews yet" or "No
 * conflicts"). What the badge's data has shows at once; the rest waits for the detail.
 */
export function MrCard({ kind, mr, detail, error = null, hint, extra }: { kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null; error?: string | null; hint?: string; extra?: ReactNode }) {
  const m = detail?.mr ?? mr;
  const wait = error ? `Couldn't load: ${error}` : 'Loading…';
  return (
    <div className="mr-card" role="group" aria-label={`${mrName(kind)} ${mrRef(kind, mr.number)} details`}>
      <div className="mr-card-title"><MrStateChip state={m.state} /> <span className="mr-card-ref">{mrRef(kind, mr.number)}</span> <EmojiText text={m.title} /></div>
      {/* The avatar's box is its size from the first render (initials until the picture comes): a tooltip never shifts. */}
      <div className="mr-card-meta mr-card-author"><ForgeAvatar user={m.author} size={16} /><span>{m.author.name}</span></div>
      <div className="mr-card-meta mr-card-branches">{branchesParts(m)[0]} <ArrowGlyph /> {branchesParts(m)[1]}</div>
      {/* Only what's worth a look: no "No pipeline", "No reviews yet" or "No conflicts". A badge's MR
          comes from the light list (no pipeline, no review): until the detail answers, one line says so. */}
      {m.pipeline && <div className="mr-card-meta"><PipelineIcon pipeline={m.pipeline} /> {pipelineText(kind, m.pipeline)}</div>}
      {detail && hasReviewNews(detail) && <div className="mr-card-meta">{reviewText(detail.mr.review)}</div>}
      {m.conflicts && <div className="mr-card-meta mr-card-bad">Has conflicts</div>}
      {!detail && <div className="mr-card-meta mr-card-wait">{wait}</div>}
      {extra}
      {hint && <div className="mr-card-hint">{hint}</div>}
    </div>
  );
}

/** A review state worth a line: anything but nobody having reviewed and nothing required. */
function hasReviewNews(d: ForgeMrDetail): boolean {
  const r = d.mr.review;
  return r.decision !== 'none' || r.approvals > 0 || (r.approvalsRequired ?? 0) > 0;
}
