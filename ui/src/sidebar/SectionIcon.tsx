import { GitPullRequest, Cloud, Laptop, Tag, TreePine } from 'lucide-react';
import { StashIcon } from '../icons/stash';
import type { Section } from './model';

/** A panel's icon: its header and its narrow-strip button show the same one. */
export function SectionIcon({ section, size = 13 }: { section: Pick<Section, 'kind'>; size?: number }) {
  switch (section.kind) {
    case 'local': return <Laptop size={size} />;
    case 'remote': return <Cloud size={size} />;
    case 'worktrees': return <TreePine size={size} />; // K74: a (pine) tree
    case 'stashes': return <StashIcon size={size} />;
    // --- 4B T11 ---
    case 'mrs':
      return <GitPullRequest size={size} />;
    // --- end 4B T11 ---
    default: return <Tag size={size} />;
  }
}
