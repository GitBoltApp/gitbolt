import { CheckCheck, ChevronDown, ChevronRight, ListMinus, ListPlus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import type { FileChange } from '../api/gen/FileChange';
import { countByStatus, type FileRow } from '../files/fileTree';
import { FileList, StatusCountsView, useFileRowH, type FileListHandle } from '../files/FileList';
import { PathTreeToggle } from '../files/PathTreeToggle';
import { useFileListPrefs } from '../files/fileListPrefs';
import { filesKey } from '../repo/services';
import type { FileSection } from '../repo/store';
import { discardUnstaged, stageAll, stagePaths, unstageAll, useWipCtx } from '../stage/actions';
import { StagingUndoButtons } from '../stage/UndoButtons';
import { ActionIcon, filesUnder, RowActions } from '../stage/RowActions';
import { COMMIT_QUEUED, useCommitting } from '../stage/store';
import type { WriteCtx } from '../write/client';
import { loadWipPanel, saveWipPanel, WIP_PANEL, wipSplitBounds, type WipPanelPrefs } from './wipPanelPrefs';
import { SplitResizer } from './SplitResizer';
import { splitConflicted } from './conflicted';
// --- 2D T15 ---
import { markResolved } from '../conflicts/resolve';
// --- end 2D T15 ---
// --- 2D T20 ---
import { isMergeDirty, MERGE_SAVE_FIRST, useMergeDirty } from '../conflicts/mergeDrafts';
// --- end 2D T20 ---

type Which = 'conflicted' | 'unstaged' | 'staged';

// --- 2D T15 ---
/** A Conflicted file row's hover action (spec #2 §13.3): Mark resolved, the file as it is (asks
 * first while conflict markers remain). */
function ConflictRowActions({ ctx, path }: { ctx: WriteCtx; path: string }) {
  const committing = useCommitting(ctx.repoId, ctx.worktree);
  // 2D T20: the merge tool's unsaved work on this file would be replaced (2B's SAVE_FIRST).
  const merging = useMergeDirty(ctx.tabId, ctx.worktree, path);
  const tip = committing ? COMMIT_QUEUED : merging ? MERGE_SAVE_FIRST : `Mark ${path} resolved`;
  return (
    <span className="row-actions">
      <ActionIcon label={`Mark ${path} resolved`} tip={tip} icon={CheckCheck} disabled={committing || merging} onClick={() => { if (!isMergeDirty(ctx.tabId, ctx.worktree, path)) void markResolved(ctx, path); }} />
    </span>
  );
}
// --- end 2D T15 ---

/** The section header's buttons (spec #2 §7.1): Unstaged has Stage all and Discard unstaged,
 * Staged has Unstage all, Conflicted none (Mark resolved is 2D's). A press doesn't toggle the
 * section. While files are conflicted, Stage all names the other unstaged paths: `git add -A`
 * would mark every conflict resolved. */
function HeadActions({ ctx, which, files, guardConflicts }: { ctx: WriteCtx; which: Which; files: FileChange[]; guardConflicts: boolean }) {
  const committing = useCommitting(ctx.repoId, ctx.worktree);
  const tip = (t: string) => (committing ? COMMIT_QUEUED : t);
  return (
    <span className="wip-head-actions" onClick={(e) => e.stopPropagation()}>
      {which === 'unstaged' && !files.every((f) => f.submodule) && <ActionIcon label="Discard unstaged" tip={tip('Discard unstaged changes')} icon={Trash2} danger disabled={committing} onClick={() => void discardUnstaged(ctx)} />}
      {which === 'unstaged'
        ? <ActionIcon label="Stage all" tip={tip('Stage all changes')} icon={ListPlus} positive text="Stage All Changes" shortText="Stage all" disabled={committing} onClick={() => void (guardConflicts ? stagePaths(ctx, files.map((f) => f.path)) : stageAll(ctx))} />
        : <ActionIcon label="Unstage all" tip={tip('Unstage all changes')} icon={ListMinus} danger text="Unstage All Changes" shortText="Unstage all" disabled={committing} onClick={() => void unstageAll(ctx)} />}
    </span>
  );
}

/** One section: a header that collapses it (title and count, then its change summary and the
 * +/− totals on the same line), and its file list, with Path/Tree left to the shared toggle. */
function WipSection({ section, which, collapsed, onToggle, sizeRef, basis, listRef, onLeave, guardConflicts = false }: {
  section: FileSection;
  /** Stage all stays off the conflicted paths (Unstaged, while Conflicted is showing). */
  guardConflicts?: boolean;
  which: Which;
  collapsed: boolean;
  onToggle: () => void;
  sizeRef?: React.Ref<HTMLElement>;
  basis?: number;
  listRef: Ref<FileListHandle>;
  onLeave: (dir: 1 | -1) => boolean;
}) {
  const label = section.title ?? which;
  const list = section.list;
  const ready = list.status === 'ready' ? list.data : null;
  const counts = ready ? countByStatus(ready.files) : null;
  // A collapsed section stays mounted, hidden, so its folders and keyboard cursor survive.
  const ctx = useWipCtx();
  const renderActions = useCallback(
    (row: FileRow) => {
      if (!ctx || !ready) return null;
      if (which === 'conflicted') return row.kind === 'file' && row.change ? <ConflictRowActions ctx={ctx} path={row.change.path} /> : null;
      return <RowActions ctx={ctx} which={which} files={filesUnder(ready, row)} name={row.kind === 'file' ? row.name : row.path} />;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx?.tabId, ctx?.repoId, ctx?.worktree, ready, which],
  );
  let body: ReactNode = null;
  // UX G.2: View all files on the Unstaged list: the worktree's tracked files around its changes
  // (untracked files are among them already), each opening its working-tree file in File View.
  const allFilesWorktree = which === 'unstaged' && section.spec.kind === 'wip' ? section.spec.worktree : null;
  // The +/− line totals sit on the list's tool line, opposite Collapse all / Sort by status, so the
  // header keeps only the change-type counts next to the title (ux round 3: one kind of number
  // per line). Like the per-type counts (K47), a zero side isn't shown, and an empty section shows
  // no totals (K86).
  const totals = ready && (ready.added > 0 || ready.deleted > 0) ? (
    <span className="file-totals" data-testid={`${which}-totals`}>
      {ready.added > 0 && <span className="added">+{ready.added}</span>}
      {ready.added > 0 && ready.deleted > 0 && ' '}
      {ready.deleted > 0 && <span className="deleted">−{ready.deleted}</span>}
    </span>
  ) : null;
  if (ready) body = <FileList ref={listRef} list={ready} spec={section.spec} label={label} allFilesWorktree={allFilesWorktree} sharedMode onLeave={onLeave} renderActions={renderActions} toolEnd={totals} />;
  else if (list.status === 'error' && !collapsed) body = <div role="alert" className="file-section-status">{list.message}</div>;
  return (
    <section
      ref={sizeRef}
      className={`file-section wip-section${which === 'conflicted' ? ' conflicted' : ''}${collapsed ? ' collapsed' : ''}${basis !== undefined ? ' sized' : ''}`}
      aria-label={label}
      data-section={which}
      style={basis !== undefined ? { flexBasis: `${basis * 100}%` } : undefined}
    >
      {/* The whole bar toggles; the button inside is its keyboard (and screen reader) face. */}
      <div className="wip-section-head" onClick={onToggle}>
        <h3 className="file-section-title">
          <button type="button" aria-expanded={!collapsed}>
            {collapsed ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
            {label}{ready && ` (${ready.files.length})`}
          </button>
        </h3>
        {counts && <span className="wip-section-summary"><StatusCountsView counts={counts} testId={`${which}-counts`} size={12} /></span>}
        {ctx && ready && ready.files.length > 0 && which !== 'conflicted' && <HeadActions ctx={ctx} which={which} files={ready.files} guardConflicts={guardConflicts} />}
      </div>
      <div className="wip-section-body" hidden={collapsed}>{body}</div>
    </section>
  );
}

/**
 * The WIP row's two file lists (spec §8.6, K36): one shared Path/Tree toggle on top, then
 * "Unstaged (n)" and "Staged (n)", each collapsible in place from its header. While
 * both are expanded, a drag handle (the details split's, rAF-coalesced) sets the split; a
 * collapsed section shrinks to its header and the other takes the space. The ratio and the
 * collapsed state persist.
 */
export function WipSections({ sections }: { sections: FileSection[] }) {
  const [prefs, setPrefs] = useState<WipPanelPrefs>(loadWipPanel);
  const ctx = useWipCtx();
  const wipAllFiles = useFileListPrefs((s) => s.wipAllFiles);
  const setListPrefs = useFileListPrefs((s) => s.set);
  const ref = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setHeight(el.clientHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rowH = useFileRowH();
  const bounds = wipSplitBounds(height, rowH);
  const shown = Math.max(bounds[0], Math.min(bounds[1], prefs.ratio));
  const update = (next: WipPanelPrefs) => { setPrefs(next); saveWipPanel(next); };
  const toggle = (which: Which) => update({ ...prefs, collapsed: { ...prefs.collapsed, [which]: !prefs.collapsed[which] } });
  const [rawUnstaged, rawStaged] = sections;
  // Conflicted files (status U) leave both lists for their own section (§7.1), once both are in.
  const split = rawUnstaged.list.status === 'ready' && rawStaged.list.status === 'ready' ? splitConflicted(rawUnstaged.list.data, rawStaged.list.data) : null;
  const unstaged: FileSection = split ? { ...rawUnstaged, list: { status: 'ready', data: split.unstaged } } : rawUnstaged;
  const staged: FileSection = split ? { ...rawStaged, list: { status: 'ready', data: split.staged } } : rawStaged;
  const conflicted: FileSection | null = split && split.conflicted.files.length > 0 ? { title: 'Conflicted', spec: rawUnstaged.spec, list: { status: 'ready', data: split.conflicted } } : null;
  const lists = { conflicted: useRef<FileListHandle>(null), unstaged: useRef<FileListHandle>(null), staged: useRef<FileListHandle>(null) };
  // Up/down run on through the expanded sections, Conflicted, Unstaged then Staged, wrapping at
  // the ends: past one list's end the next takes over, skipping any that is collapsed or empty
  // (then false, and the list wraps on its own).
  const leave = (from: Which) => (dir: 1 | -1) => {
    const order: Which[] = conflicted ? ['conflicted', 'unstaged', 'staged'] : ['unstaged', 'staged'];
    const n = order.length;
    for (let step = 1; step < n; step++) {
      const to = order[(order.indexOf(from) + dir * step + n * n) % n];
      const h = lists[to].current;
      if (prefs.collapsed[to] || !h?.hasFiles()) continue;
      h.enter(dir === 1 ? 'first' : 'last');
      return true;
    }
    return false;
  };
  const both = !prefs.collapsed.unstaged && !prefs.collapsed.staged;
  return (
    <div className="wip-sections">
      <div className="wip-view-bar">
        {/* UX G.2: here rather than in a list's tool line, so a clean worktree (an Edit stop with
            nothing changed yet) has it too. It shows the tracked files in the Unstaged list. */}
        <button type="button" className="toolbar-button wip-all-files" aria-pressed={wipAllFiles} onClick={() => setListPrefs({ wipAllFiles: !wipAllFiles })}>View all files</button>
        <PathTreeToggle />
        {ctx && <StagingUndoButtons ctx={ctx} />}
      </div>
      {conflicted && <WipSection key={`${filesKey(conflicted.spec)}|conflicted`} section={conflicted} which="conflicted" collapsed={prefs.collapsed.conflicted} onToggle={() => toggle('conflicted')} listRef={lists.conflicted} onLeave={leave('conflicted')} />}
      {/* The split is of this box, the height left once Conflicted has taken its share. */}
      <div ref={ref} className="wip-split">
      <WipSection key={filesKey(unstaged.spec)} section={unstaged} which="unstaged" guardConflicts={conflicted !== null} collapsed={prefs.collapsed.unstaged} onToggle={() => toggle('unstaged')} listRef={lists.unstaged} onLeave={leave('unstaged')} sizeRef={topRef} basis={both ? shown : undefined} />
      {both && (
        <SplitResizer
          ratio={shown}
          bounds={bounds}
          height={height}
          onChange={(ratio) => setPrefs((p) => ({ ...p, ratio }))}
          onCommit={(ratio) => saveWipPanel({ ...prefs, ratio })}
          targetRef={topRef}
          label="Resize unstaged and staged files"
          step={WIP_PANEL.step}
          defaultRatio={WIP_PANEL.defaultRatio}
        />
      )}
      <WipSection key={filesKey(staged.spec)} section={staged} which="staged" collapsed={prefs.collapsed.staged} onToggle={() => toggle('staged')} listRef={lists.staged} onLeave={leave('staged')} />
      </div>
    </div>
  );
}
