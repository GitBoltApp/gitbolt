import { Check, Cloud, FolderOpen, Laptop, Tag } from 'lucide-react';
import type { RefLabel } from '../api/gen/RefLabel';
import { GRAPH_COLORS } from '../theme/graphColors';

function Chip({ label, color }: { label: RefLabel; color: string }) {
  return (
    <span className="ref-label" style={{ ['--lane-color' as string]: color }} title={label.local ?? label.remotes[0]?.fullName ?? label.name}>
      {label.isHead && <Check size={12} aria-label="HEAD" />}
      {label.tag && <Tag size={12} aria-label="tag" />}
      <span className="ref-name">{label.name}</span>
      {label.local && <Laptop size={12} aria-label="local" />}
      {label.remotes.map((r) => <Cloud key={r.fullName} size={12} aria-label={`remote ${r.remote}`} />)}
      {label.worktree && <FolderOpen size={12} aria-label="checked out in another worktree" />}
    </span>
  );
}

export function RefLabels({ labels, color }: { labels: RefLabel[]; color: number }) {
  if (labels.length === 0) return null;
  const c = GRAPH_COLORS[color % GRAPH_COLORS.length];
  const rest = labels.slice(1);
  return (
    // `--lane-color` is set here (not just on the chip) so `.ref-connector`, a sibling of the
    // chip, can read it too: it continues the connector drawn in the canvas (see draw.ts).
    <span className="ref-labels" style={{ ['--lane-color' as string]: c }}>
      <Chip label={labels[0]} color={c} />
      {rest.length > 0 && <span className="ref-more" title={rest.map((l) => l.name).join('\n')}>+{rest.length}</span>}
      <span className="ref-connector" />
    </span>
  );
}
