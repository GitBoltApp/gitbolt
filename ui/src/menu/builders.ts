import { Minus, Plus, Trash2 } from 'lucide-react';
import type { FileChange } from '../api/gen/FileChange';
import { activeStore, activeTab } from '../app/actions';
import { discardPaths, pathsOf, stagePaths, unstageFiles } from '../stage/actions';
import { COMMIT_QUEUED, stagingKey, useStaging } from '../stage/store';
import { refTokenFromLabel } from '../details/messageLinks';
import { branchUrl, commitUrl, fileUrl, repoUrl, type ProjectRemote } from '../forge/urls';
import { defaultOpener, openerRowId, openInSubmenuRows } from '../openIn/openerRows';
import { shortSha } from '../format/sha';
import { removeRemote } from '../remotes/remove';
import { ICONS } from './icons';
import type { CommitTarget, FileTarget, FolderTarget, MenuEnv, MonacoTarget, SidebarTarget, TagTarget } from './menuEnv';
import { registerMenu, tmpl } from './registry';
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

// --- 2B T9: a WIP file's Stage / Unstage and Discard changes (spec #2 §7.1) ---
registerMenu<FileTarget, MenuEnv>({
  id: 'file.stage', kind: 'file', group: 'stage', order: 0,
  // A conflicted file's rows (Take current / incoming, Mark resolved) are 2D's.
  when: (t) => !!t.wip && t.wip.status !== 'U',
  rows: (t) => {
    const wip = t.wip!;
    const tab = activeTab();
    const repo = activeStore()?.getState().repo;
    if (!tab || repo === undefined) return [];
    const ctx = { tabId: tab.id, repoId: repo, worktree: wip.worktree };
    const queued = useStaging.getState().committing[stagingKey(repo, wip.worktree)] ? COMMIT_QUEUED : undefined;
    if (wip.staged) {
      const change = { path: t.path, oldPath: wip.oldPath } as FileChange;
      return [row({ id: 'file.unstage', label: 'Unstage', icon: Minus, tooltip: 'Move this file’s staged changes back to Unstaged', run: () => void unstageFiles(ctx, [change]), disabledReason: queued })];
    }
    return [
      row({ id: 'file.stageFile', label: 'Stage', icon: Plus, tooltip: 'Stage this file’s changes', run: () => void stagePaths(ctx, pathsOf([{ path: t.path, oldPath: wip.oldPath }])), disabledReason: queued }),
      // A submodule's changes are discarded inside it.
      ...(wip.submodule ? [] : [row({ id: 'file.discard', label: 'Discard changes', icon: Trash2, tooltip: 'Discard this file’s unstaged changes (you can undo this)', run: () => void discardPaths(ctx, pathsOf([{ path: t.path, oldPath: wip.oldPath }])), disabledReason: queued })]),
    ];
  },
});
// --- end 2B T9 ---

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
  // One row, `View | Diff | File |` (K58): the label opens the diff (the default; the file when
  // it's unchanged, which has no diff), Diff and File are the variants.
  rows: (t, env) => {
    const diffReason = t.changed ? undefined : 'Unchanged in this commit';
    const variants: Variant[] = [
      { id: 'diff', label: 'Diff', icon: ICONS.diff, tooltip: "Show this file's changes in the center panel", run: () => env.act.openDiff(t.diff), disabledReason: diffReason },
      { id: 'file', label: 'File', icon: ICONS.file, tooltip: viewTooltip(t), run: () => env.act.viewFile(t.diff) },
    ];
    return [row({
      id: 'file.view', label: 'View', icon: diffReason ? ICONS.file : ICONS.diff,
      tooltip: diffReason ? viewTooltip(t) : "Show this file's changes in the center panel",
      run: () => (diffReason ? env.act.viewFile(t.diff) : env.act.openDiff(t.diff)), variants,
    })];
  },
});

// The folder menu (tree mode's folder rows): its path, and the file manager.
registerMenu<FolderTarget, MenuEnv>({ id: 'folder.copy', kind: 'folder', group: 'copy', order: 0, rows: (t, env) => [copyPath('folder.copyPath', t.path, t.root, env)] });
registerMenu<FolderTarget, MenuEnv>({
  id: 'folder.open', kind: 'folder', group: 'open', order: 0,
  rows: (t, env) => {
    const { list, error } = env.openers;
    return [{ kind: 'submenu', id: 'folder.openIn', label: 'Open in', icon: ICONS.reveal, tooltip: 'Show the directory in the file manager', rows: openInSubmenuRows(list, error, (o) => env.act.openIn(o, t.openIn), { folder: true }) }];
  },
});

// Plan 1C Task 15 (lane W2-D): the commit, tag and Monaco kinds, registered next to 1B's file and
// folder rows above, with new ids (a duplicate id throws at import, preflight.md T15). Still
// pure: no API client import (builders.test.ts's throwing proxy covers these too).

/** A commit target's branch, as its remote-tracking ref (origin first, spec §7's `⎇`/forge rows). */
const remoteBranch = (b: CommitTarget['branch']) => {
  const r = b?.remotes.find((x) => x.remote === 'origin') ?? b?.remotes[0];
  return r ? { remote: r.remote, name: r.fullName.slice(`refs/remotes/${r.remote}/`.length) } : null;
};

/**
 * `Forge link | ⎇ | ◉ | Open |` for a target whose commit permalink is always known (a real
 * commit, unlike a file that might not be committed yet): the M report's shape (item 10, spec
 * §7's Amendment 6) — the label copies the branch link when there is one, else the permalink; ⎇
 * and ◉ copy each explicitly; Open opens the default in the browser.
 */
function commitForgeRow(id: string, name: string, branch: { url: string | null }, commitLink: string, env: MenuEnv): MenuRow {
  const url = branch.url ?? commitLink;
  const variants: Variant[] = [
    ...(branch.url ? [{ id: 'branch', icon: ICONS.branch, tooltip: `Copy the branch's link on ${name}`, run: () => env.act.copy(branch.url!) }] : []),
    { id: 'commit', icon: ICONS.commit, tooltip: `Copy a ${name} permalink pinned to this commit`, run: () => env.act.copy(commitLink) },
    { id: 'open', icon: ICONS.browser, tooltip: `Open on ${name} in the browser`, run: () => env.act.openUrl(url) },
  ];
  return row({ id, label: 'Forge link', icon: ICONS.forge, tooltip: `Copy the link to ${branch.url ? 'the branch' : 'this commit'} on ${name}`, run: () => env.act.copy(url), variants });
}

/** A single-link forge row (a tag's page): copy on the label, an Open variant (same shape as
 * `commitForgeRow`, without the branch/commit split a tag has no use for). */
function simpleForgeRow(id: string, url: string, what: string, env: MenuEnv): MenuRow {
  return row({ id, label: 'Forge link', icon: ICONS.forge, tooltip: `Copy ${what}`, run: () => env.act.copy(url), variants: [{ id: 'open', icon: ICONS.browser, tooltip: `Open ${what} in the browser`, run: () => env.act.openUrl(url) }] });
}

/** One `Open <ref>` row per distinct MR/PR reference in the commit message (spec §7's target
 * table; issues get no button, M report deviation 9's `ForgeRef.type`). */
registerMenu<CommitTarget, MenuEnv>({
  id: 'commit.forge.refs', kind: 'commit', group: 'forge', order: 0,
  when: (t) => !t.isWip,
  rows: (t, env) => {
    const f = env.forge();
    if (!f) return [];
    const seen = new Set<string>();
    return t.mrRefs.flatMap((label) => {
      const token = refTokenFromLabel(label, f);
      if (!token || token.kind !== 'link' || token.ref?.type !== 'mr' || seen.has(token.url)) return [];
      seen.add(token.url);
      const kind = f.hostKind === 'gitlab' ? 'merge request' : 'pull request';
      return [row({ id: `commit.openRef.${token.ref.label}`, label: `Open ${token.ref.label}`, icon: ICONS.mr, tooltip: `Open ${kind} ${token.ref.label} on ${forgeName(f)}`, run: () => env.act.openUrl(token.url) })];
    });
  },
});

/** `Copy branch name | Local | Remote |` · `Copy SHA | Short | Full |` · `Copy message` ·
 * `Forge link | ⎇ | ◉ | Open |`, one group (spec §7's target table puts the commit's Forge link
 * in the copy group, unlike the file menu's own `forge` group). */
registerMenu<CommitTarget, MenuEnv>({
  id: 'commit.copy', kind: 'commit', group: 'copy', order: 0,
  when: (t) => !t.isWip,
  rows: (t, env) => {
    const out: MenuRow[] = [];
    const b = t.branch;
    if (b) {
      const local = b.local?.replace(/^refs\/heads\//, '') ?? null;
      const rb = remoteBranch(b);
      out.push(row({
        id: 'commit.copyBranch', label: 'Copy branch name', icon: ICONS.branch, tooltip: `Copy "${b.name}"`, run: () => env.act.copy(b.name),
        // Only the names it has: no Local on a remote-only branch, no Remote on an unpushed one.
        variants: [
          ...(local ? [{ id: 'local', label: 'Local', tooltip: `Copy the local branch name (${local})`, run: () => env.act.copy(local) }] : []),
          ...(rb ? [{ id: 'remote', label: 'Remote', tooltip: `Copy "${rb.remote}/${rb.name}"`, run: () => env.act.copy(`${rb.remote}/${rb.name}`) }] : []),
        ],
      }));
    }
    out.push(row({
      id: 'commit.copySha', label: 'Copy SHA', icon: ICONS.sha, tooltip: 'Copy the full commit id', run: () => env.act.copy(t.sha),
      variants: [
        { id: 'short', label: 'Short', tooltip: `Copy the short id (${shortSha(t.sha)})`, run: () => env.act.copy(shortSha(t.sha)) },
        { id: 'full', label: 'Full', tooltip: 'Copy the full 40-character id', run: () => env.act.copy(t.sha) },
      ],
    }));
    out.push(row({ id: 'commit.copyMessage', label: 'Copy message', icon: ICONS.message, tooltip: 'Copy the full commit message', run: () => env.act.copyMessage(t.sha) }));
    const rb = remoteBranch(b);
    const f = env.forge(rb?.remote);
    if (f) out.push(commitForgeRow('commit.forgeLink', forgeName(f), { url: rb ? branchUrl(f, rb.name) : null }, commitUrl(f, t.sha)!, env));
    return out;
  },
});

/** `Compare with HEAD` (a branch's tip) or `Compare with working tree` (a plain commit, or HEAD's
 * own). */
registerMenu<CommitTarget, MenuEnv>({
  id: 'commit.view', kind: 'commit', group: 'view', order: 0,
  when: (t) => !t.isWip,
  // Compare with HEAD only where it compares something: not on HEAD's own commit, nor without one.
  rows: (t, env) => t.branch && env.headSha && env.headSha !== t.sha
    ? [row({
      id: 'commit.compareHead', label: 'Compare with HEAD', icon: ICONS.compare, tooltip: tmpl('Compare {Y} with HEAD ({X})', { X: env.headBranch, Y: t.branch.name }),
      run: () => env.headSha && env.act.compare(t.sha, env.headSha),
    })]
    : [row({ id: 'commit.compareWorktree', label: 'Compare with working tree', icon: ICONS.compare, tooltip: 'Compare this commit with the files on disk', run: () => env.act.compare(t.sha, 'worktree') })],
});

/** `Forge link` · `Copy tag name` (spec §7's tag row; 1B's `GROUP_ORDER.tag` puts forge first). */
registerMenu<TagTarget, MenuEnv>({
  id: 'tag.forge', kind: 'tag', group: 'forge', order: 0,
  rows: (t, env) => {
    const f = env.forge();
    if (!f) return [];
    const name = forgeName(f);
    const url = branchUrl(f, t.name);
    return url ? [simpleForgeRow('tag.forgeLink', url, `the tag's page on ${name}`, env)] : [];
  },
});
registerMenu<TagTarget, MenuEnv>({
  id: 'tag.copy', kind: 'tag', group: 'copy', order: 0,
  rows: (t, env) => [row({ id: 'tag.copyName', label: 'Copy tag name', icon: ICONS.copy, tooltip: `Copy "${t.name}"`, run: () => env.act.copy(t.name) })],
});

/** `path:line` or `path:from-to` (a multi-line selection), the Monaco menu's Copy location. */
const monacoLocation = (t: MonacoTarget) => `${t.path}:${t.lines[0]}${t.lines[1] !== t.lines[0] ? `-${t.lines[1]}` : ''}`;

registerMenu<MonacoTarget, MenuEnv>({
  id: 'monaco.copy', kind: 'monaco', group: 'copy', order: 0,
  rows: (t, env) => [
    row({ id: 'monaco.copySelection', label: 'Copy', icon: ICONS.copy, tooltip: 'Copy the selected text', run: () => env.act.copy(t.selectionText), disabledReason: t.selectionText ? undefined : 'Nothing selected' }),
    row({
      id: 'monaco.copyLocation', label: 'Copy location', icon: ICONS.copy, tooltip: `Copy "${monacoLocation(t)}"`, run: () => env.act.copy(monacoLocation(t)),
      variants: [
        { id: 'rel', label: monacoLocation(t), tooltip: 'Copy the repository-relative location', run: () => env.act.copy(monacoLocation(t)) },
        { id: 'abs', label: 'Abs', tooltip: 'Copy the absolute path with the line', run: () => env.act.copy(`${t.openIn.worktree}/${monacoLocation(t)}`) },
      ],
    }),
  ],
});

/** `Forge link | ⎇ | ◉ | Open |`, with the selection's line anchor. */
registerMenu<MonacoTarget, MenuEnv>({
  id: 'monaco.forge', kind: 'monaco', group: 'forge', order: 0,
  rows: (t, env) => {
    const f = env.forge(t.upstream?.remote);
    if (!f) return [];
    const name = forgeName(f);
    const lines = { a: t.lines[0], b: t.lines[1] };
    const branchLink = t.upstream ? fileUrl(f, t.upstream.branch, t.path, lines) : null;
    const commitLink = t.sha ? fileUrl(f, t.sha, t.path, lines) : null;
    const url = branchLink ?? commitLink;
    if (!url) return [];
    const variants: Variant[] = [
      { id: 'branch', icon: ICONS.branch, tooltip: t.upstream ? `Copy the link to this file on ${t.upstream.remote}/${t.upstream.branch} (${name})` : `Copy the branch's link on ${name}`, run: () => branchLink && env.act.copy(branchLink), disabledReason: branchLink ? undefined : "The commit's branch has no known upstream" },
      { id: 'commit', icon: ICONS.commit, tooltip: `Copy a ${name} permalink pinned to this commit`, run: () => commitLink && env.act.copy(commitLink), disabledReason: commitLink ? undefined : 'Not committed yet' },
      { id: 'open', icon: ICONS.browser, tooltip: `Open on ${name} in the browser`, run: () => env.act.openUrl(url) },
    ];
    return [row({ id: 'monaco.forgeLink', label: 'Forge link', icon: ICONS.forge, tooltip: `Copy the link to this file on ${name}`, run: () => env.act.copy(url), variants })];
  },
});

registerMenu<MonacoTarget, MenuEnv>({
  id: 'monaco.open', kind: 'monaco', group: 'open', order: 0,
  rows: (t, env) => {
    const { list, error } = env.openers;
    return [{ kind: 'submenu', id: 'monaco.openIn', label: 'Open in', icon: ICONS.editor, tooltip: `Open the file in another application at line ${t.lines[0]}`, rows: openInSubmenuRows(list, error, (o) => env.act.openIn(o, t.openIn)) }];
  },
});

// Plan 1C Task 15b: the sidebar's own rows (remote, worktree, stash), and the "Show in graph" row
// that ends every sidebar item's menu. A branch or tag item gets its `commit`/`tag` menu first
// (`sidebarItemMenu`). Read-only: checkout, delete, push… are sub-project #2's.

/** `Copy SHA | Short | Full |`. */
const copySha = (id: string, sha: string, env: MenuEnv): MenuRow => row({
  id, label: 'Copy SHA', icon: ICONS.sha, tooltip: 'Copy the full commit id', run: () => env.act.copy(sha),
  variants: [
    { id: 'short', label: 'Short', tooltip: `Copy the short id (${shortSha(sha)})`, run: () => env.act.copy(shortSha(sha)) },
    { id: 'full', label: 'Full', tooltip: 'Copy the full 40-character id', run: () => env.act.copy(sha) },
  ],
});

registerMenu<SidebarTarget, MenuEnv>({
  id: 'sidebar.copy', kind: 'sidebar', group: 'copy', order: 0,
  rows: (t, env) => {
    switch (t.what) {
      case 'remote':
        return [
          row({ id: 'sidebar.copyRemote', label: 'Copy remote name', icon: ICONS.copy, tooltip: `Copy "${t.name}"`, run: () => env.act.copy(t.name) }),
          row({ id: 'sidebar.copyUrl', label: 'Copy URL', icon: ICONS.browser, tooltip: t.url ? `Copy the remote's URL (${t.url})` : "The remote's URL isn't loaded yet", run: () => t.url && env.act.copy(t.url), disabledReason: t.url ? undefined : 'Not loaded yet' }),
        ];
      case 'worktree':
        return [
          row({ id: 'sidebar.copyPath', label: 'Copy path', icon: ICONS.copy, tooltip: `Copy "${t.path}"`, run: () => env.act.copy(t.path) }),
          ...(t.branch ? [row({ id: 'sidebar.copyBranch', label: 'Copy branch name', icon: ICONS.branch, tooltip: `Copy "${t.branch}"`, run: () => env.act.copy(t.branch!) })] : []),
          ...(t.head ? [copySha('sidebar.copySha', t.head, env)] : []),
        ];
      case 'stash':
        return [
          copySha('sidebar.copySha', t.sha, env),
          row({ id: 'sidebar.copyStash', label: 'Copy message', icon: ICONS.message, tooltip: "Copy the stash's message", run: () => env.act.copy(t.message) }),
        ];
      case 'ref':
        return [];
    }
  },
});

/** A remote's `Forge link | Open |`: its project's home page. */
registerMenu<SidebarTarget, MenuEnv>({
  id: 'sidebar.forge', kind: 'sidebar', group: 'forge', order: 0,
  when: (t) => t.what === 'remote',
  rows: (t, env) => {
    const f = t.what === 'remote' ? env.forge(t.name) : null;
    const url = f ? repoUrl(f) : null;
    if (!f || !url) return [];
    const name = forgeName(f);
    return [row({ id: 'sidebar.forgeLink', label: 'Forge link', icon: ICONS.forge, tooltip: `Copy the link to the project on ${name}`, run: () => env.act.copy(url), variants: [{ id: 'open', icon: ICONS.browser, tooltip: `Open the project on ${name} in the browser`, run: () => env.act.openUrl(url) }] })];
  },
});

/** A forge remote's "Use as the main remote": the target of the repo's MRs/PRs; again: Automatic. */
registerMenu<SidebarTarget, MenuEnv>({
  id: 'sidebar.mainRemote', kind: 'sidebar', group: 'forge', order: 1,
  when: (t) => t.what === 'remote',
  rows: (t, env) => {
    const f = t.what === 'remote' ? env.forge(t.name) : null;
    if (t.what !== 'remote' || !f || !env.mainRemote) return [];
    const m = env.mainRemote;
    const noun = f.hostKind === 'github' ? 'pull requests' : 'merge requests';
    const on = m.chosen === t.name;
    return [row({
      id: 'sidebar.mainRemote', label: 'Use as the main remote', icon: on ? ICONS.check : ICONS.mainRemote,
      tooltip: on ? 'The main remote: click to go back to Automatic' : `Make this the remote whose project is used for ${noun}`,
      run: () => m.toggle(t.name),
    })];
  },
});

/** Remove remote…: last in a remote's menu; arms in place (danger), then the journaled write. */
registerMenu<SidebarTarget, MenuEnv>({
  id: 'sidebar.removeRemote', kind: 'sidebar', group: 'manage', order: 0,
  when: (t, env) => t.what === 'remote' && !!env.write,
  rows: (t, env) => (t.what === 'remote' && env.write
    ? [row({ id: 'sidebar.removeRemote', label: 'Remove remote…', icon: Trash2, tooltip: `Remove ${t.name} with its remote branches; branches tracking it lose their upstream (you can undo this)`, run: () => { void removeRemote(env.write!, t.name); } })]
    : []),
});

registerMenu<SidebarTarget, MenuEnv>({
  id: 'sidebar.open', kind: 'sidebar', group: 'open', order: 0,
  when: (t) => t.what === 'worktree',
  rows: (t, env) => (t.what === 'worktree'
    ? [row({ id: 'sidebar.openFolder', label: 'Open in file manager', icon: ICONS.reveal, tooltip: "Show the worktree's directory in the file manager", run: () => env.act.openFolder(t.path) })]
    : []),
});

registerMenu<SidebarTarget, MenuEnv>({
  id: 'sidebar.view', kind: 'sidebar', group: 'view', order: 0,
  rows: (t, env) => {
    const sha = t.what === 'ref' || t.what === 'stash' ? t.sha : t.what === 'worktree' ? t.head : null;
    if (!sha) return [];
    const loaded = env.inGraph(sha);
    return [row({
      id: 'sidebar.showInGraph', label: 'Show in graph', icon: ICONS.graph, tooltip: 'Select this commit in the graph',
      run: () => env.act.showInGraph(sha), disabledReason: loaded ? undefined : 'Not in the loaded history',
    })];
  },
});
