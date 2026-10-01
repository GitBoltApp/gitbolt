import { Archive, FolderTree, Laptop, Tag } from 'lucide-react';
import { RemoteIcon } from '../icons/brands';
import { HoverTooltip } from '../ui/HoverTooltip';
import type { Section } from './model';

/** Spec §6.4 narrow mode: one icon per section with its count. */
export function NarrowStrip({ sections, onExpand }: { sections: Section[]; onExpand(): void }) {
  return (
    <aside className="sidebar-narrow" aria-label="Sidebar (collapsed)">
      {sections.map((s) => {
        const icon = s.kind === 'local' ? <Laptop size={15} /> : s.kind === 'remote' ? <RemoteIcon kind={s.hostKind ?? 'generic'} remote={s.label} size={15} />
          : s.kind === 'worktrees' ? <FolderTree size={15} /> : s.kind === 'stashes' ? <Archive size={15} /> : <Tag size={15} />;
        return (
          <HoverTooltip key={s.id} content={`${s.label}: ${s.items.length}`}>
            <button type="button" className="sn-item" aria-label={`${s.label} (${s.items.length})`} onClick={onExpand}>
              {icon}<span className="sn-count">{s.items.length}</span>
            </button>
          </HoverTooltip>
        );
      })}
    </aside>
  );
}
