import { createPortal } from 'react-dom';
import { HoverTooltip } from '../ui/HoverTooltip';

const lines = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`;

/** §7.3: beside a selection that covers changed lines, Stage / Discard N lines (unstaged), or
 * Unstage N lines (staged). Each button's N is what its write takes (the no-newline tie
 * included). A press doesn't move the editor's selection. */
export function LineActionBar({ rect, apply, discard, staged, canDiscard, reason, onApply, onDiscard }: {
  rect: { top: number; left: number; bottom: number };
  apply: number;
  discard: number;
  staged: boolean;
  canDiscard: boolean;
  reason: string | null;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const button = (label: string, onClick: () => void, danger = false) => (
    <HoverTooltip content={reason ?? label}>
      <button type="button" className={`line-action${danger ? ' danger' : ''}`} aria-disabled={reason !== null} onMouseDown={(e) => e.preventDefault()} onClick={() => { if (reason === null) onClick(); }}>{label}</button>
    </HoverTooltip>
  );
  return createPortal(
    <div className="line-action-bar" role="toolbar" aria-label="Selected lines" style={{ top: rect.bottom + 4, left: rect.left + 24 }}>
      {staged
        ? button(`Unstage ${lines(apply)}`, onApply)
        : <>{button(`Stage ${lines(apply)}`, onApply)}{canDiscard && button(`Discard ${lines(discard)}`, onDiscard, true)}</>}
    </div>,
    document.body,
  );
}
