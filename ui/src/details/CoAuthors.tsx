import type { CoAuthor } from '../api/gen/CoAuthor';
import { Avatar } from '../avatars/Avatar';
import { useHoverTooltip } from '../ui/HoverTooltip';
import './header.css';

function CoAuthorChip({ c }: { c: CoAuthor }) {
  // Portaled (HoverTooltip), so the scrolling details panel can't clip it.
  const { triggerProps, tooltip } = useHoverTooltip({
    content: <div className="hovercard"><div className="hovercard-title">{c.name}</div><div>{c.email}</div></div>,
  });
  return (
    <span className="co-author" data-testid="co-author" {...triggerProps}>
      <Avatar name={c.name} email={c.email} size={18} />
      {c.name}
      {tooltip}
    </span>
  );
}

/** The commit's `Co-authored-by:` trailers (spec §9.1), one chip each. */
export function CoAuthors({ coAuthors }: { coAuthors: CoAuthor[] }) {
  if (coAuthors.length === 0) return null;
  return (
    <div className="co-authors" role="group" aria-label="Co-authors">
      {coAuthors.map((c) => <CoAuthorChip key={c.email || c.name} c={c} />)}
    </div>
  );
}
