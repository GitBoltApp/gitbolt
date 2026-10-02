import { Minus, Plus, Trash2, type LucideIcon } from 'lucide-react';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { FileRow } from '../files/fileTree';
import { HoverTooltip } from '../ui/HoverTooltip';
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
export function ActionIcon({ label, tip, icon: Icon, disabled = false, danger = false, onClick }: { label: string; tip: string; icon: LucideIcon; disabled?: boolean; danger?: boolean; onClick: () => void }) {
  return (
    <HoverTooltip content={tip}>
      <button
        type="button"
        className={`row-action${danger ? ' danger' : ''}`}
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
        <Icon size={13} aria-hidden />
      </button>
    </HoverTooltip>
  );
}

/** A WIP row's hover actions (spec #2 §7.1): unstaged rows Discard and Stage,
 * staged rows Unstage. A folder row acts on every file under it. */
export function RowActions({ ctx, which, files, name }: { ctx: WriteCtx; which: 'unstaged' | 'staged'; files: FileChange[]; name: string }) {
  const committing = useCommitting(ctx.repoId, ctx.worktree);
  if (files.length === 0) return null;
  // A submodule's own changes are discarded inside it (T4): its row offers no Discard.
  const discardable = files.filter((f) => !f.submodule);
  return (
    <span className="row-actions">
      {which === 'unstaged' && discardable.length > 0 && <ActionIcon label={`Discard ${name}`} tip={committing ? COMMIT_QUEUED : 'Discard changes'} icon={Trash2} danger disabled={committing} onClick={() => void discardPaths(ctx, discardable.map((f) => f.path))} />}
      {which === 'unstaged'
        ? <ActionIcon label={`Stage ${name}`} tip={committing ? COMMIT_QUEUED : 'Stage'} icon={Plus} disabled={committing} onClick={() => void stagePaths(ctx, files.map((f) => f.path))} />
        : <ActionIcon label={`Unstage ${name}`} tip={committing ? COMMIT_QUEUED : 'Unstage'} icon={Minus} disabled={committing} onClick={() => void unstageFiles(ctx, files)} />}
    </span>
  );
}
