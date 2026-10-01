import { Archive, Cloud, Laptop, Tag, TreePine } from 'lucide-react';
import type { Section } from './model';

/** A panel's icon: its header and its narrow-strip button show the same one. */
export function SectionIcon({ section, size = 13 }: { section: Pick<Section, 'kind'>; size?: number }) {
  switch (section.kind) {
    case 'local': return <Laptop size={size} />;
    case 'remote': return <Cloud size={size} />;
    case 'worktrees': return <TreePine size={size} />; // K74: a (pine) tree
    case 'stashes': return <Archive size={size} />;
    default: return <Tag size={size} />;
  }
}
