import { Minus, Plus, Trash2, type LucideIcon } from 'lucide-react';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { FileRow } from '../files/fileTree';
import { useRef } from 'react';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useDisarmOnChange } from '../ui/arm/useDisarmOnChange';
import { confirmAction } from '../ui/ConfirmDialog';
import type { WriteCtx } from '../write/client';
import { discardPaths, stagePaths, unstageFiles } from './actions';
import { COMMIT_QUEUED, useCommitting } from './store';
import './stage.css';

/** A row's files: the file itself, or every file under a tree-mode folder. */
export function filesUnder(list: FileListPayload, row: FileRow): FileChange[] {
  if (row.kind === 'file') return row.change ? [row.change] : [];
  const prefix = `${row.path}/`;
  return list.files.filter((f) => f.path.startsWith(prefix));
}

/** An icon button inside a row: a press never selects the row or moves the list's focus. */
export function ActionIcon({ label, tip, icon: Icon, disabled = false, danger = false, positive = false, text, shortText, onClick }: { label: string; tip: string; icon: LucideIcon; disabled?: boolean; danger?: boolean; positive?: boolean; /** A text button; the icon alone shows when the panel is narrow. */ text?: string; /** A shorter label for a medium-width panel. */ shortText?: string; onClick: () => void }) {
  return (
    <HoverTooltip content={tip}>
      <button
        type="button"
        className={`row-action${danger ? ' danger' : ''}${positive ? ' positive' : ''}${text ? ' has-text' : ''}`}
        aria-label={label}
        aria-disabled={disabled}
        tabIndex={-1}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) onClick();
        }}
      >
        <Icon size={text ? 14 : 13} aria-hidden />
        {text && <span className="row-action-text">{text}</span>}
        {shortText && <span className="row-action-short">{shortText}</span>}
      </button>
    </HoverTooltip>
  );
}

/** A WIP row's hover actions (spec #2 §7.1): unstaged rows Discard and Stage,
 * staged rows Unstage. A folder row acts on every file under it. */
export function RowActions({ ctx, which, files, name }: { ctx: WriteCtx; which: 'unstaged' | 'staged'; files: FileChange[]; name: string }) {
  const committing = useCommitting(ctx.repoId, ctx.worktree);
  // An armed Discard names its files: another row in this place (a refresh) disarms it.
  const ref = useRef<HTMLSpanElement>(null);
  useDisarmOnChange(ref, `${ctx.worktree}\0${files.map((f) => f.path).join('\0')}`);
  if (files.length === 0) return null;
  // A submodule's own changes are discarded inside it (T4): its row offers no Discard.
  const discardable = files.filter((f) => !f.submodule);
  // Discard arms in place, over the row's other actions (spec §ui confirms, board C).
  const discard = async () => {
    const n = discardable.length;
    const arm = n === 1 ? `Click again to discard ${name}` : `Click again to discard ${n} files in ${name}`;
    if (await confirmAction({ title: `Discard ${name}?`, body: 'Its changes are removed. You can undo this.', confirmLabel: 'Discard', arm, danger: true })) {
      await discardPaths(ctx, discardable.map((f) => f.path));
    }
  };
  return (
    <span ref={ref} className="row-actions" data-arm-cover="" data-arm-grow="left">
      {which === 'unstaged' && discardable.length > 0 && <ActionIcon label={`Discard ${name}`} tip={committing ? COMMIT_QUEUED : 'Discard changes'} icon={Trash2} danger disabled={committing} onClick={() => void discard()} />}
      {which === 'unstaged'
        ? <ActionIcon label={`Stage ${name}`} tip={committing ? COMMIT_QUEUED : 'Stage'} icon={Plus} positive text="Stage File" disabled={committing} onClick={() => void stagePaths(ctx, files.map((f) => f.path))} />
        : <ActionIcon label={`Unstage ${name}`} tip={committing ? COMMIT_QUEUED : 'Unstage'} icon={Minus} danger text="Unstage File" disabled={committing} onClick={() => void unstageFiles(ctx, files)} />}
    </span>
  );
}
