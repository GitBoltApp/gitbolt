import type { CoAuthor } from '../api/gen/CoAuthor';
import { Avatar } from '../avatars/Avatar';
import { useHoverTooltip } from '../ui/HoverTooltip';
import './header.css';

/** "Name <email>" (feedback F14); the name alone when there is no email. */
export const personLabel = (name: string, email: string) => (email ? `${name} <${email}>` : name);

function CoAuthorChip({ c }: { c: CoAuthor }) {
  // Portaled (HoverTooltip), so the details panel can't clip it.
  const { triggerProps, tooltip } = useHoverTooltip({ content: personLabel(c.name, c.email) });
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
