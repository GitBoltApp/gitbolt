import { Check, Cloud, FolderOpen, Laptop, Tag } from 'lucide-react';
import { useState } from 'react';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RemoteRefLabel } from '../api/gen/RemoteRefLabel';
import { GRAPH_COLORS } from '../theme/graphColors';
import { useHoverTooltip } from '../ui/HoverTooltip';

/** `origin/foo` for `refs/remotes/origin/foo`: exact (it keeps an upstream's own branch name). */
const remoteShort = (r: RemoteRefLabel) => r.fullName.replace(/^refs\/remotes\//, '');

/** Every ref the chip stands for, one per line: `refs/heads/foo`, `origin/foo`, `upstream/foo`. */
const refList = (l: RefLabel) => (l.tag ? [`refs/tags/${l.name}`] : [...(l.local ? [l.local] : []), ...l.remotes.map(remoteShort)]).join('\n') || l.name;

/** A remote-only label's `name` is just the branch part (the payload drops the remote name,
 * since the chip's remote icons say it's remote). The `+N` tooltip is plain text with no icons,
 * so there it gets its remote prefix back, for every remote it's on. */
const overflowName = (l: RefLabel) => (!l.local && l.remotes.length > 0 ? l.remotes.map(remoteShort).join(', ') : l.name);

function ChipContent({ label, full }: { label: RefLabel; full?: boolean }) {
  return (
    <>
      {label.isHead && <Check size={12} aria-label="HEAD" />}
      {label.tag && <Tag size={12} aria-label="tag" />}
      <span className={full ? 'ref-name-full' : 'ref-name'}>{label.name}</span>
      {label.local && <Laptop size={12} aria-label="local" />}
      {label.remotes.map((r) => <Cloud key={r.fullName} size={12} aria-label={`remote ${r.remote}`} />)}
      {label.worktree && <FolderOpen size={12} aria-label="checked out in another worktree" />}
    </>
  );
}

/**
 * The row's first label. Hovering it floats an untruncated copy (`.ref-label-full`) exactly over
 * it: absolutely positioned (so the in-flow chip, the `+N` badge and the connector keep their
 * resting geometry) and above the canvas (graph.css). The copy is a DOM child of the chip, so
 * moving onto the part of it that sticks out doesn't count as leaving. The instant tooltip lists
 * the refs the chip stands for.
 */
function Chip({ label, color }: { label: RefLabel; color: string }) {
  const [expanded, setExpanded] = useState(false);
  const { triggerProps, tooltip } = useHoverTooltip({ content: refList(label) });
  return (
    <span
      className="ref-label"
      style={{ ['--lane-color' as string]: color }}
      onMouseEnter={(e) => { setExpanded(true); triggerProps.onMouseEnter(e); }}
      onMouseLeave={(e) => { setExpanded(false); triggerProps.onMouseLeave(e); }}
    >
      <ChipContent label={label} />
      {expanded && (
        <span className="ref-label ref-label-full" aria-hidden="true">
          <ChipContent label={label} full />
        </span>
      )}
      {tooltip}
    </span>
  );
}

function More({ rest }: { rest: RefLabel[] }) {
  const { triggerProps, tooltip } = useHoverTooltip({ content: rest.map(overflowName).join('\n') });
  return (
    <span className="ref-more" {...triggerProps}>
      +{rest.length}
      {tooltip}
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
      {rest.length > 0 && <More rest={rest} />}
      <span className="ref-connector" />
    </span>
  );
}
