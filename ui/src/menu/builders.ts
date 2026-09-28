import { fileUrl, type ProjectRemote } from '../forge/urls';
import { defaultOpener, openerRowId, openInSubmenuRows } from '../openIn/openerRows';
import { shortSha } from '../format/sha';
import { ICONS } from './icons';
import type { FileTarget, FolderTarget, MenuEnv } from './menuEnv';
import { registerMenu } from './registry';
import type { MenuRow, Variant } from './types';

// Pure: rows are built only from the target and the in-memory env (spec §7). Never call the API
// client here; builders.test.ts proves it with a throwing mock. Plan 1C Task 15 adds the
// commit, tag and Monaco contributions to this module; 1B ships the file menu only.

type Action = Extract<MenuRow, { kind: 'action' }>;
const row = (r: Omit<Action, 'kind'>): MenuRow => ({ kind: 'action', ...r });
const forgeName = (f: ProjectRemote) => (f.hostKind === 'gitlab' ? 'GitLab' : 'GitHub');

/** `Copy path | Rel | Abs |`, for a file or a folder. */
function copyPath(id: string, path: string, root: string, env: MenuEnv): MenuRow {
  const abs = `${root}/${path}`;
  return row({
    id, label: 'Copy path', icon: ICONS.copy, tooltip: `Copy "${path}"`, run: () => env.act.copy(path),
    variants: [
      { id: 'rel', label: 'Rel', tooltip: `Copy the repository-relative path (${path})`, run: () => env.act.copy(path) },
      { id: 'abs', label: 'Abs', tooltip: `Copy the absolute path on disk (${abs})`, run: () => env.act.copy(abs) },
    ],
  });
}

registerMenu<FileTarget, MenuEnv>({ id: 'file.copy', kind: 'file', group: 'copy', order: 0, rows: (t, env) => [copyPath('file.copyPath', t.path, t.root, env)] });

/**
 * `Forge link | ⎇ | ◉ | Open |` (spec §7: the label copies the URL, an Open variant opens it).
 * ⎇ copies the file on the selected commit's branch upstream, ◉ a permalink pinned to the
 * commit; the label copies (and Open opens) the branch link when there is one, else the
 * permalink.
 */
registerMenu<FileTarget, MenuEnv>({
  id: 'file.forge', kind: 'file', group: 'forge', order: 0,
  rows: (t, env) => {
    const up = t.upstream;
    const f = env.forge(up?.remote);
    if (!f) return [];
    const name = forgeName(f);
    const branch = up ? fileUrl(f, up.branch, t.path) : null;
    const commit = t.sha ? fileUrl(f, t.sha, t.path) : null;
    const url = branch ?? commit;
    const branchReason = t.sha ? "The commit's branch has no known upstream" : 'The working tree\'s branch has no known upstream';
    const commitReason = 'Not committed yet';
    const reason = `${branchReason}, and the file isn't committed yet`;
    const which = branch ? `the file on ${up!.remote}/${up!.branch}` : 'the permalink';
    const variants: Variant[] = [
      { id: 'branch', icon: ICONS.branch, tooltip: up ? `Copy the link to the file on ${up.remote}/${up.branch} (${name})` : `Copy the link to the file on its branch (${name})`, run: () => branch && env.act.copy(branch), disabledReason: branch ? undefined : branchReason },
      { id: 'commit', icon: ICONS.commit, tooltip: t.sha ? `Copy a ${name} permalink pinned to commit ${shortSha(t.sha)}` : `Copy a ${name} permalink pinned to the commit`, run: () => commit && env.act.copy(commit), disabledReason: commit ? undefined : commitReason },
      { id: 'open', icon: ICONS.browser, tooltip: `Open ${which} on ${name} in the browser`, run: () => url && env.act.openUrl(url), disabledReason: url ? undefined : reason },
    ];
    return [row({ id: 'file.forge', label: 'Forge link', icon: ICONS.forge, tooltip: url ? `Copy the link to ${which} on ${name}` : reason, run: () => url && env.act.copy(url), variants, disabledReason: url ? undefined : reason })];
  },
});

/** `Open in ▸`: the detected openers (the same rows as the diff header's Open in button), the
 * last used one active. */
registerMenu<FileTarget, MenuEnv>({
  id: 'file.open', kind: 'file', group: 'open', order: 0,
  rows: (t, env) => {
    const { list, error, last } = env.openers;
    const copy = t.openIn.source?.kind === 'object' || t.openIn.source?.kind === 'atCommit';
    const initial = list ? defaultOpener(list, last) : null;
    return [{
      kind: 'submenu', id: 'file.openIn', label: 'Open in', icon: ICONS.editor, tooltip: 'Open the file in another application',
      rows: openInSubmenuRows(list, error, (o) => env.act.openIn(o, t.openIn), { copy }),
      initial: initial ? openerRowId(initial) : undefined,
    }];
  },
});

/** What "View file" shows, said for the list it's in. A deleted file shows its last version:
 * the commit's parent's (a commit), the compare's "from" side (a compare, or one with the
 * working tree, whose file is gone from disk). */
function viewTooltip(t: FileTarget): string {
  if (!t.deleted) return t.sha ? 'Show the whole file as it was in this commit' : 'Show the whole file, this version';
  if (t.list === 'commit') return 'Show the whole file as it was before this commit deleted it';
  if (t.list === 'worktree') return `Show the whole file as it was at ${t.sha ? shortSha(t.sha) : 'the compared commit'}, before it was deleted from the working tree`;
  if (t.list === 'compare') return `Show the whole file as it was at ${t.sha ? shortSha(t.sha) : 'the older commit'}, before it was deleted`;
  return 'Show the whole file as it was before it was deleted';
}

registerMenu<FileTarget, MenuEnv>({
  id: 'file.view', kind: 'file', group: 'view', order: 0,
  rows: (t, env) => [
    row({ id: 'file.diff', label: 'Open diff', icon: ICONS.diff, tooltip: "Show this file's changes in the center panel", run: () => env.act.openDiff(t.diff), disabledReason: t.changed ? undefined : 'Unchanged in this commit' }),
    row({ id: 'file.view', label: t.sha ? 'View file at this commit' : 'View file', icon: ICONS.file, tooltip: viewTooltip(t), run: () => env.act.viewFile(t.diff) }),
  ],
});

// The folder menu (tree mode's folder rows): its path, and the file manager.
registerMenu<FolderTarget, MenuEnv>({ id: 'folder.copy', kind: 'folder', group: 'copy', order: 0, rows: (t, env) => [copyPath('folder.copyPath', t.path, t.root, env)] });
registerMenu<FolderTarget, MenuEnv>({
  id: 'folder.open', kind: 'folder', group: 'open', order: 0,
  rows: (t, env) => {
    const { list, error } = env.openers;
    return [{ kind: 'submenu', id: 'folder.openIn', label: 'Open in', icon: ICONS.reveal, tooltip: 'Show the folder in the file manager', rows: openInSubmenuRows(list, error, (o) => env.act.openIn(o, t.openIn), { folder: true }) }];
  },
});
