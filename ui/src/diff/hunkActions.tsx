import { Minus, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import type { Hunk } from '../api/gen/Hunk';
import type { LineRange } from '../api/gen/LineRange';
import type { StageSelection } from '../api/gen/StageSelection';
import { useRepoContext } from '../app/repoContext';
import type { DiffTarget } from '../repo/store';
import { discardPatch, stagePatch } from '../stage/actions';
import { COMMIT_QUEUED, useCommitting } from '../stage/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useDiffPrefs } from './diffPrefs';
import { LineActionBar } from './LineActionBar';
import type { DiffSelection } from './monaco/host';
import { useMonacoHost } from './TextDiff';
import { useWipHunks, wipSideOf } from './wipHunks';
import { SAVE_FIRST, useIsDirty } from './workingCopy';

export { wipSideOf };

const toRanges = (lines: number[]): LineRange[] =>
  [...lines].sort((a, b) => a - b).reduce<LineRange[]>((out, n) => {
    const last = out[out.length - 1];
    if (last && last.end + 1 === n) last.end = n;
    else out.push({ start: n, end: n });
    return out;
  }, []);

/** §7.3: only changed lines count, on the side the selection is in. */
export function selectedChanges(hunks: Hunk[], sel: DiffSelection): { old: LineRange[]; new: LineRange[]; count: number } {
  const lines = hunks.flatMap((h) => (sel.side === 'original' ? h.del : h.add)).filter((n) => n >= sel.start && n <= sel.end);
  const ranges = toRanges(lines);
  return sel.side === 'original' ? { old: ranges, new: [], count: lines.length } : { old: [], new: ranges, count: lines.length };
}

function HunkButton({ label, icon: Icon, reason, onClick, danger = false }: { label: string; icon: typeof Plus; reason: string | null; onClick: () => void; danger?: boolean }) {
  return (
    <HoverTooltip content={reason ?? label}>
      <button type="button" className={`hunk-button${danger ? ' danger' : ''}`} aria-label={label} aria-disabled={reason !== null} onMouseDown={(e) => e.preventDefault()} onClick={() => { if (reason === null) onClick(); }}>
        <Icon size={12} aria-hidden /> {label}
      </button>
    </HoverTooltip>
  );
}

/** One hunk's header buttons: Stage hunk and Discard hunk (unstaged), Unstage hunk (staged). */
export function HunkButtons({ staged, canDiscard, reason, onStage, onDiscard }: { staged: boolean; canDiscard: boolean; reason: string | null; onStage: () => void; onDiscard: () => void }) {
  return (
    <span className="hunk-buttons">
      {staged
        ? <HunkButton label="Unstage hunk" icon={Minus} reason={reason} onClick={onStage} />
        : <>
            <HunkButton label="Stage hunk" icon={Plus} reason={reason} onClick={onStage} />
            {canDiscard && <HunkButton label="Discard hunk" icon={Trash2} danger reason={reason} onClick={onDiscard} />}
          </>}
    </span>
  );
}

/** The hunk zone's place: above the hunk's first line, or after the line a pure insertion or
 * deletion sits at (an empty range is numbered by the line before it). */
const zoneAfter = (start: number, lines: number) => (lines === 0 ? start : Math.max(0, start - 1));

/**
 * The hunk header zones and the line action bar over a WIP text diff (§7.3), in Hunk, Inline and
 * Split modes. Hunks come from the backend (`wipHunks`), never from Monaco. `shownSeq` bumps each
 * time the diff is on screen, so the zones follow a new show. Disabled while the working copy is
 * unsaved ("Save first", §7.5) and while a commit for the worktree is queued. A file whose hunks
 * and lines can't be staged shows why, and no buttons.
 */
export function HunkActions({ target, shownSeq }: { target: DiffTarget; shownSeq: number }) {
  const { tabId, repoId } = useRepoContext();
  const { host } = useMonacoHost();
  const side = wipSideOf(target);
  const mode = useDiffPrefs((s) => s.prefs.mode);
  const payload = useWipHunks(repoId, target, shownSeq);
  const dirty = useIsDirty(tabId);
  const committing = useCommitting(repoId, side?.worktree ?? '');
  const reason = dirty ? SAVE_FIRST : committing ? COMMIT_QUEUED : null;
  const [nodes, setNodes] = useState<HTMLElement[]>([]);
  const [sel, setSel] = useState<DiffSelection | null>(null);
  const [counts, setCounts] = useState<{ token: string; apply: number; discard: number } | null>(null);
  const hunks = payload && !payload.binary && payload.refused === null ? payload.hunks : [];
  useEffect(() => {
    if (!host) return;
    setNodes(host.setHunkZones(hunks.map((h) => ({ newAfter: zoneAfter(h.newStart, h.newLines), oldAfter: zoneAfter(h.oldStart, h.oldLines) }))));
    return () => void host.setHunkZones([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, payload, shownSeq, mode]);
  useEffect(() => {
    setSel(null);
    if (!host) return;
    host.onDiffSelection(setSel);
    return () => host.onDiffSelection(null);
  }, [host, shownSeq]);
  const changes = sel && hunks.length > 0 ? selectedChanges(hunks, sel) : null;
  const selection: StageSelection | null = changes && changes.count > 0 ? { kind: 'lines', old: changes.old, new: changes.new } : null;
  // The bar shows what the write will take: the backend counts after the no-newline tie.
  const token = selection && side && payload ? JSON.stringify([target.key, selection, payload.base]) : null;
  useEffect(() => {
    if (!token || !selection || !side) return;
    let live = true;
    const fallback = changes?.count ?? 0;
    api.selectionLines(repoId, side.worktree, target.path, side.staged, selection).then(
      (c) => { if (live) setCounts({ token, apply: c.apply, discard: c.discard }); },
      () => { if (live) setCounts({ token, apply: fallback, discard: fallback }); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  if (!side || !payload) return null;
  if (payload.refused !== null) return <div role="note" className="diff-banner hunk-refused">{payload.refused}</div>;
  const ctx = { tabId, repoId, worktree: side.worktree };
  const canDiscard = target.new.kind === 'worktree';
  const run = (picked: StageSelection, discard: boolean) =>
    void (discard ? discardPatch(ctx, target.path, picked, payload.base) : stagePatch(ctx, target.path, side.staged, picked, payload.base));
  // Until the new selection's counts land, the last ones (or the local count) keep the bar steady.
  const local = changes?.count ?? 0;
  const bar = sel && selection ? (counts ?? { token: '', apply: local, discard: local }) : null;
  return (
    <>
      {nodes.map((node, i) => createPortal(
        <HunkButtons staged={side.staged} canDiscard={canDiscard} reason={reason} onStage={() => run({ kind: 'hunks', hunks: [i] }, false)} onDiscard={() => run({ kind: 'hunks', hunks: [i] }, true)} />,
        node,
        `hunk-${i}`,
      ))}
      {sel && selection && bar && bar.apply > 0 && (
        <LineActionBar
          rect={sel.rect}
          apply={bar.apply}
          discard={bar.discard}
          staged={side.staged}
          canDiscard={canDiscard}
          reason={reason}
          onApply={() => run(selection, false)}
          onDiscard={() => run(selection, true)}
        />
      )}
    </>
  );
}
