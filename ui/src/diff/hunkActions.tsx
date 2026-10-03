import { Minus, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import type { Hunk } from '../api/gen/Hunk';
import type { LineRange } from '../api/gen/LineRange';
import type { StageSelection } from '../api/gen/StageSelection';
import { useRepoContext } from '../app/repoContext';
import type { MenuRow } from '../menu/types';
import type { DiffTarget } from '../repo/store';
import { discardPatch, stagePatch } from '../stage/actions';
import { COMMIT_QUEUED, useCommitting } from '../stage/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { LineActionBar } from './LineActionBar';
import type { DiffSelection, EditorContextMenuEvent } from './monaco/host';
import { provideStagingRows } from './stagingMenu';
import { useMonacoHost } from './TextDiff';
import { hunkHeader, hunksOf, useShownHunks, wipSideOf } from './wipHunks';
import { SAVE_FIRST, useIsDirty } from './workingCopy';

export { wipSideOf };

type Side = DiffSelection['side'];
type LineSpan = Pick<DiffSelection, 'side' | 'start' | 'end'>;

const toRanges = (lines: number[]): LineRange[] =>
  [...lines].sort((a, b) => a - b).reduce<LineRange[]>((out, n) => {
    const last = out[out.length - 1];
    if (last && last.end + 1 === n) last.end = n;
    else out.push({ start: n, end: n });
    return out;
  }, []);

/** §7.3: only changed lines count, on the side the selection is in. */
export function selectedChanges(hunks: Hunk[], sel: LineSpan): { old: LineRange[]; new: LineRange[]; count: number } {
  const lines = hunks.flatMap((h) => (sel.side === 'original' ? h.del : h.add)).filter((n) => n >= sel.start && n <= sel.end);
  const ranges = toRanges(lines);
  return sel.side === 'original' ? { old: ranges, new: [], count: lines.length } : { old: [], new: ranges, count: lines.length };
}

/** The index of the hunk whose range on `side` holds `line` (its context lines included), or -1. */
export function hunkAt(hunks: Hunk[], side: Side, line: number): number {
  return hunks.findIndex((h) => {
    const [start, n] = side === 'original' ? [h.oldStart, h.oldLines] : [h.newStart, h.newLines];
    return n === 0 ? line === start : line >= start && line < start + n;
  });
}

/** One line's selection, on its side. */
const oneLine = (side: Side, line: number): StageSelection => ({ kind: 'lines', old: side === 'original' ? [{ start: line, end: line }] : [], new: side === 'modified' ? [{ start: line, end: line }] : [] });

/**
 * The editor menu's staging rows (§7.3): for the changed lines the selection covers (else
 * the clicked line), Stage / Discard (unstaged) or Unstage "this line" / "these lines"; then the
 * clicked line's hunk. `span` is the lines on their side; `hunk` the hunk's index, or -1.
 */
export function stagingMenuRows({ hunks, span, hunk, staged, canDiscard, reason, run }: {
  hunks: Hunk[];
  span: LineSpan;
  hunk: number;
  staged: boolean;
  canDiscard: boolean;
  reason: string | null;
  run: (s: StageSelection, discard: boolean) => void;
}): MenuRow[] {
  const disabledReason = reason ?? undefined;
  const row = (id: string, label: string, icon: typeof Plus, tooltip: string, go: () => void): MenuRow => ({ kind: 'action', id, label, icon, tooltip, run: go, disabledReason });
  const out: MenuRow[] = [];
  const changes = selectedChanges(hunks, span);
  if (changes.count > 0) {
    const sel: StageSelection = { kind: 'lines', old: changes.old, new: changes.new };
    const which = changes.count === 1 ? 'this line' : 'these lines';
    if (staged) out.push(row('diff.unstageLines', `Unstage ${which}`, Minus, `Move ${which} back to Unstaged`, () => run(sel, false)));
    else {
      out.push(row('diff.stageLines', `Stage ${which}`, Plus, `Stage ${which} only`, () => run(sel, false)));
      if (canDiscard) out.push(row('diff.discardLines', `Discard ${which}`, Trash2, `Discard ${which} from the file (you can undo this)`, () => run(sel, true)));
    }
  }
  if (hunk >= 0) {
    if (out.length) out.push({ kind: 'separator' });
    const sel: StageSelection = { kind: 'hunks', hunks: [hunk] };
    if (staged) out.push(row('diff.unstageHunk', 'Unstage hunk', Minus, 'Move this hunk back to Unstaged', () => run(sel, false)));
    else {
      out.push(row('diff.stageHunk', 'Stage hunk', Plus, 'Stage this hunk', () => run(sel, false)));
      if (canDiscard) out.push(row('diff.discardHunk', 'Discard hunk', Trash2, 'Discard this hunk from the file (you can undo this)', () => run(sel, true)));
    }
  }
  return out;
}

function HunkButton({ label, icon: Icon, reason, onClick, tone }: { label: string; icon: typeof Plus; reason: string | null; onClick: () => void; tone: 'positive' | 'danger' }) {
  return (
    <HoverTooltip content={reason ?? label}>
      <button type="button" className={`hunk-button ${tone}`} aria-label={label} aria-disabled={reason !== null} onMouseDown={(e) => e.preventDefault()} onClick={() => { if (reason === null) onClick(); }}>
        <Icon size={12} aria-hidden /> {label}
      </button>
    </HoverTooltip>
  );
}

/** One hunk's header buttons: Discard hunk and Stage hunk (unstaged), Unstage hunk (staged). */
export function HunkButtons({ staged, canDiscard, reason, onStage, onDiscard }: { staged: boolean; canDiscard: boolean; reason: string | null; onStage: () => void; onDiscard: () => void }) {
  return (
    <span className="hunk-buttons">
      {staged
        ? <HunkButton label="Unstage hunk" icon={Minus} tone="danger" reason={reason} onClick={onStage} />
        : <>
            {canDiscard && <HunkButton label="Discard hunk" icon={Trash2} tone="danger" reason={reason} onClick={onDiscard} />}
            <HunkButton label="Stage hunk" icon={Plus} tone="positive" reason={reason} onClick={onStage} />
          </>}
    </span>
  );
}

/**
 * The staging controls of a WIP text diff (§7.3), over the hunks the diff was shown with
 * (`wipHunkZones`, from the backend, never from Monaco):
 * - Hunk mode: a header row above each hunk, `@@ … @@` with its buttons, laid out with the diff;
 * - every mode: the gutter's + / − on the hovered changed line, and the editor menu's rows for the
 *   selected (or clicked) lines and the clicked line's hunk;
 * - a selection covering changed lines: the line action bar.
 * Disabled while the working copy is unsaved ("Save first", §7.5) and while a commit for the
 * worktree is queued. A file whose hunks and lines can't be staged shows why, and no buttons.
 */
export function HunkActions({ target }: { target: DiffTarget }) {
  const { tabId, repoId } = useRepoContext();
  const { host } = useMonacoHost();
  const side = wipSideOf(target);
  const shown = useShownHunks((s) => (s.shown && s.shown.repoId === repoId && s.shown.key === target.key ? s.shown : null));
  const payload = shown?.payload ?? null;
  const dirty = useIsDirty(tabId);
  const committing = useCommitting(repoId, side?.worktree ?? '');
  const reason = dirty ? SAVE_FIRST : committing ? COMMIT_QUEUED : null;
  const [sel, setSel] = useState<DiffSelection | null>(null);
  const [counts, setCounts] = useState<{ token: string; apply: number; discard: number } | null>(null);
  const hunks = hunksOf(payload);
  const ctx = { tabId, repoId, worktree: side?.worktree ?? '' };
  const canDiscard = target.new.kind === 'worktree';
  const run = (picked: StageSelection, discard: boolean) => {
    if (!side || !payload) return;
    void (discard ? discardPatch(ctx, target.path, picked, payload.base) : stagePatch(ctx, target.path, side.staged, picked, payload.base));
  };
  // The gutter and the menu call back later: always with this render's values.
  const latest = useRef({ run, hunks, sel, reason, canDiscard, staged: !!side?.staged, path: target.path });
  latest.current = { run, hunks, sel, reason, canDiscard, staged: !!side?.staged, path: target.path };
  useEffect(() => {
    setSel(null);
    if (!host) return;
    host.onDiffSelection(setSel);
    return () => host.onDiffSelection(null);
  }, [host, payload]);
  useEffect(() => {
    if (!host || hunks.length === 0) return;
    host.setLineGutter({
      old: new Set(hunks.flatMap((h) => h.del)),
      new: new Set(hunks.flatMap((h) => h.add)),
      staged: !!side?.staged,
      disabled: reason,
      onLine: (s, n) => latest.current.run(oneLine(s, n), false),
    });
    return () => host.setLineGutter(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, payload, reason, side?.staged]);
  useEffect(() => provideStagingRows((e: EditorContextMenuEvent) => {
    const l = latest.current;
    if (e.path !== l.path || e.side === 'file' || l.hunks.length === 0) return [];
    const span: LineSpan = e.deletedLine !== undefined
      ? { side: 'original', start: e.deletedLine, end: e.deletedLine }
      : l.sel && l.sel.side === e.side && e.selection
        ? l.sel
        : e.selection ? { side: e.side, start: e.selection.startLine, end: e.selection.endLine } : { side: e.side, start: e.line, end: e.line };
    const hunk = hunkAt(l.hunks, e.deletedLine !== undefined ? 'original' : e.side, e.deletedLine ?? e.line);
    return stagingMenuRows({ hunks: l.hunks, span, hunk, staged: l.staged, canDiscard: l.canDiscard, reason: l.reason, run: l.run });
  }), []);
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
  // Until the new selection's counts land, the last ones (or the local count) keep the bar steady.
  const local = changes?.count ?? 0;
  const bar = sel && selection ? (counts ?? { token: '', apply: local, discard: local }) : null;
  return (
    <>
      {shown?.nodes.map((node, i) => hunks[i] && createPortal(
        <>
          <span className="hunk-header-text">{hunkHeader(hunks[i])}</span>
          <HunkButtons staged={side.staged} canDiscard={canDiscard} reason={reason} onStage={() => run({ kind: 'hunks', hunks: [i] }, false)} onDiscard={() => run({ kind: 'hunks', hunks: [i] }, true)} />
        </>,
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
