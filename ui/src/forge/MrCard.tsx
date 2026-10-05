import type { ReactNode } from 'react';
import type { ForgeKind } from '../api/gen/ForgeKind';
import type { ForgeMr } from '../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../api/gen/ForgeMrDetail';
import { ForgeAvatar } from '../avatars/Avatar';
import { EmojiText } from './emoji';
import { mrName, mrRef } from './labels';
import { MrStateIcon, PipelineIcon } from './MrIcons';
import { ArrowGlyph } from '../ui/ArrowGlyph';
import { branchesParts, conflictText, pipelineText, reviewText } from './mrText';

/**
 * The hover card's body (spec #4 §4 "4B"): number, title, author, target branch, draft, pipeline,
 * approvals / review state, conflicts. What the badge's data has shows at once; the review and
 * (on GitHub) the conflicts wait for the detail.
 */
export function MrCard({ kind, mr, detail, error = null, hint, extra }: { kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null; error?: string | null; hint?: string; extra?: ReactNode }) {
  const m = detail?.mr ?? mr;
  const wait = error ? `Couldn't load: ${error}` : 'Loading…';
  return (
    <div className="mr-card" role="group" aria-label={`${mrName(kind)} ${mrRef(kind, mr.number)} details`}>
      <div className="mr-card-title"><MrStateIcon state={m.state} /> <span className="mr-card-ref">{mrRef(kind, mr.number)}</span> <EmojiText text={m.title} /></div>
      {/* The avatar's box is its size from the first render (initials until the picture comes): a tooltip never shifts. */}
      <div className="mr-card-meta mr-card-author"><ForgeAvatar user={m.author} size={16} /><span>{m.author.name} · {branchesParts(m)[0]} <ArrowGlyph /> {branchesParts(m)[1]}{m.state === 'draft' ? ' · Draft' : ''}</span></div>
      {/* A badge's MR comes from the light list (no pipeline): wait for the detail rather than say "No pipeline". */}
      <div className="mr-card-meta">{m.pipeline ? <><PipelineIcon pipeline={m.pipeline} /> {pipelineText(kind, m.pipeline)}</> : detail ? pipelineText(kind, null) : wait}</div>
      <div className="mr-card-meta">{detail ? reviewText(detail.mr.review) : wait}</div>
      <div className="mr-card-meta">{detail || m.conflicts !== null ? conflictText(m.conflicts) : wait}</div>
      {extra}
      {hint && <div className="mr-card-hint">{hint}</div>}
    </div>
  );
}
