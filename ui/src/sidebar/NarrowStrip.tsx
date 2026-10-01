import { ChevronRight } from 'lucide-react';
import { HoverTooltip } from '../ui/HoverTooltip';
import type { Panel } from './model';
import { SectionIcon } from './SectionIcon';

/** Spec §6.4 narrow mode: a vertical strip, a (>) button on top that expands the sidebar, then
 * one icon per panel with its (filtered) count below it. Clicking an icon expands the sidebar
 * with that panel open. */
export function NarrowStrip({ panels, onExpand, onPick }: { panels: Panel[]; onExpand(): void; onPick(sectionId: string): void }) {
  return (
    <aside className="sidebar-narrow" aria-label="Sidebar (collapsed)">
      <HoverTooltip content="Expand sidebar (Ctrl+B)">
        <button type="button" className="sn-expand" aria-label="Expand sidebar" onClick={onExpand}><ChevronRight size={14} /></button>
      </HoverTooltip>
      {panels.map((p) => (
        <HoverTooltip key={p.section.id} content={`${p.section.label}: ${p.matched}`}>
          <button type="button" className="sn-item" aria-label={`${p.section.label} (${p.matched})`} onClick={() => onPick(p.section.id)}>
            <SectionIcon section={p.section} size={15} /><span className="sn-count">{p.matched}</span>
          </button>
        </HoverTooltip>
      ))}
    </aside>
  );
}
