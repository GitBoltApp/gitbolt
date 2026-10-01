import type { LucideIcon } from 'lucide-react';
import { HoverTooltip } from '../ui/HoverTooltip';
import { isCollapsed } from './columns';

/**
 * A graph table header's title (spec §8.4). At its column's minimum width it's the column's icon
 * instead, with the column's name in an instant tooltip and as its accessible name. SHA isn't a
 * collapsible column: it always shows its text (a plain `.col-title`).
 */
export function HeaderCell({ col, width, title, name, icon: Icon }: { col: 'labels' | 'graph' | 'message' | 'author' | 'date'; width: number; title: string; name: string; icon: LucideIcon }) {
  if (!isCollapsed(col, width)) return <span className="col-title">{title}</span>;
  return (
    <HoverTooltip content={name}>
      <span className="col-title col-icon" role="img" aria-label={name}><Icon size={13} aria-hidden /></span>
    </HoverTooltip>
  );
}
