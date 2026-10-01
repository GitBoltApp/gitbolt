import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import type { DiffTarget } from '../repo/store';
import { shortSha } from '../format/sha';
import type { MenuRow } from './types';

// Menus are built synchronously from memory (spec §7): a builder that touched the backend would
// hit this proxy and throw.
vi.mock('../api/client', () => ({ api: new Proxy({}, { get() { throw new Error('menu builders must never call the backend'); } }) }));

const { buildMenu } = await import('./registry');
beforeAll(async () => { await import('./builders'); });

import type { CommitTarget, FileTarget, FolderTarget, MenuEnv, MonacoTarget, TagTarget } from './menuEnv';

type Action = Extract<MenuRow, { kind: 'action' }>;
type Submenu = Extract<MenuRow, { kind: 'submenu' }>;

const OPENERS: OpenerPayload[] = [
  { id: 'vscode', name: 'VS Code', kind: 'editor' },
  { id: 'jetbrains-phpstorm', name: 'PhpStorm', kind: 'editor' },
  { id: 'file-manager', name: 'Files', kind: 'fileManager' },
  { id: 'other', name: 'Other…', kind: 'chooser' },
];
const gitlab = { host: 'gitlab.example.com', path: 'acme/shop', hostKind: 'gitlab' as const };
const github = { host: 'github.com', path: 'owner/repo', hostKind: 'github' as const };
const act = () => ({ copy: vi.fn(), openUrl: vi.fn(), openIn: vi.fn(), openDiff: vi.fn(), viewFile: vi.fn(), compare: vi.fn(), copyMessage: vi.fn() });
const envOf = (over: Partial<MenuEnv> = {}): MenuEnv => ({ forge: () => gitlab, openers: { list: OPENERS, error: null, last: null }, act: act(), headBranch: 'main', headSha: 'h'.repeat(40), ...over });
const sha = 'a'.repeat(40);
const diff: DiffTarget = { key: 'k|src/a b.php', path: 'src/a b.php', oldPath: null, status: 'M', old: { kind: 'object', oid: 'o'.repeat(40) }, new: { kind: 'object', oid: 'n'.repeat(40) }, view: 'diff' };
const target = (over: Partial<FileTarget> = {}): FileTarget => ({
  path: 'src/a b.php', root: '/r', sha, upstream: { remote: 'origin', branch: 'feature/x' }, diff, changed: true, deleted: false, list: 'commit',
  openIn: { worktree: '/r', path: 'src/a b.php', line: null, source: diff.new, fallback: null }, ...over,
});
const labels = (rows: MenuRow[]) => rows.map((r) => (r.kind === 'separator' ? '---' : r.label));
const find = (rows: MenuRow[], label: string) => rows.find((r) => r.kind !== 'separator' && r.label === label) as Action;
const variant = (r: Action, id: string) => r.variants!.find((v) => v.id === id)!;
const file = (t: FileTarget, env: MenuEnv) => buildMenu<FileTarget, MenuEnv>('file', t, env);

describe('the file menu (spec §7; plan 1C Task 15, file kind)', () => {
  it('rows in group order; every row, variant and submenu row has an icon and a tooltip', () => {
    const rows = file(target(), envOf());
    expect(labels(rows)).toEqual(['Copy path', '---', 'Forge link', '---', 'Open in', '---', 'Open diff', 'View file at this commit']);
    const all = (rs: MenuRow[]): Array<Exclude<MenuRow, { kind: 'separator' }>> => rs.flatMap((r) => (r.kind === 'separator' ? [] : r.kind === 'submenu' ? [r, ...all(r.rows)] : [r]));
    for (const r of all(rows)) {
      expect(r.icon, r.id).toBeTruthy();
      expect(r.tooltip.length, r.id).toBeGreaterThan(3);
      if (r.kind === 'action') for (const v of r.variants ?? []) expect(v.tooltip.length, v.id).toBeGreaterThan(3);
    }
  });

  it('Copy path: the label and Rel copy the relative path, Abs the absolute one', () => {
    const env = envOf();
    const row = find(file(target({ root: '/wt/feature' }), env), 'Copy path');
    expect(row.variants!.map((v) => v.label)).toEqual(['Rel', 'Abs']);
    row.run();
    expect(env.act.copy).toHaveBeenLastCalledWith('src/a b.php');
    variant(row, 'abs').run();
    expect(env.act.copy).toHaveBeenLastCalledWith('/wt/feature/src/a b.php');
    variant(row, 'rel').run();
    expect(env.act.copy).toHaveBeenLastCalledWith('src/a b.php');
  });

  it('Forge link: the label copies (branch link first), ⎇ and ◉ copy theirs, Open opens', () => {
    const env = envOf();
    const row = find(file(target(), env), 'Forge link');
    expect(row.variants!.map((v) => v.id)).toEqual(['branch', 'commit', 'open']);
    const branchUrl = 'https://gitlab.example.com/acme/shop/-/blob/feature/x/src/a%20b.php';
    const permalink = `https://gitlab.example.com/acme/shop/-/blob/${sha}/src/a%20b.php`;
    row.run();
    expect(env.act.copy).toHaveBeenLastCalledWith(branchUrl);
    variant(row, 'commit').run();
    expect(env.act.copy).toHaveBeenLastCalledWith(permalink);
    variant(row, 'branch').run();
    expect(env.act.copy).toHaveBeenLastCalledWith(branchUrl);
    variant(row, 'open').run();
    expect(env.act.openUrl).toHaveBeenLastCalledWith(branchUrl);
    expect(variant(row, 'branch').tooltip).toContain('origin/feature/x');
  });

  it('Forge link: no known upstream greys out ⎇ with a reason, and the permalink becomes the default', () => {
    const env = envOf();
    const row = find(file(target({ upstream: null }), env), 'Forge link');
    expect(variant(row, 'branch').disabledReason).toMatch(/no known upstream/);
    row.run();
    expect(env.act.copy).toHaveBeenLastCalledWith(`https://gitlab.example.com/acme/shop/-/blob/${sha}/src/a%20b.php`);
    variant(row, 'open').run();
    expect(env.act.openUrl).toHaveBeenLastCalledWith(`https://gitlab.example.com/acme/shop/-/blob/${sha}/src/a%20b.php`);
  });

  it('Forge link: a working-tree file has no permalink; with no upstream either the row is disabled', () => {
    const wip = find(file(target({ sha: null }), envOf()), 'Forge link');
    expect(variant(wip, 'commit').disabledReason).toBe('Not committed yet');
    expect(wip.disabledReason).toBeUndefined();
    const none = find(file(target({ sha: null, upstream: null }), envOf()), 'Forge link');
    expect(none.disabledReason).toBeTruthy();
    expect(variant(none, 'open').disabledReason).toBeTruthy();
  });

  it('Forge link: the upstream remote picks the forge; a generic host has no forge row', () => {
    const forge = vi.fn((_remote?: string) => gitlab);
    file(target({ upstream: { remote: 'fork', branch: 'x' } }), envOf({ forge }));
    expect(forge).toHaveBeenCalledWith('fork');
    expect(labels(file(target(), envOf({ forge: () => null })))).not.toContain('Forge link');
  });

  it('Open in ▸: the detected editors, then Show in Files, then Other…; picking one opens the target', () => {
    const env = envOf({ openers: { list: OPENERS, error: null, last: 'jetbrains-phpstorm' } });
    const t = target();
    const sub = file(t, env).find((r) => r.kind === 'submenu') as Submenu;
    expect(sub.label).toBe('Open in');
    expect(labels(sub.rows)).toEqual(['Open in VS Code', 'Open in PhpStorm', '---', 'Show in Files', 'Other…']);
    // The last used starts active.
    expect(sub.initial).toBe('opener.jetbrains-phpstorm');
    find(sub.rows, 'Show in Files').run();
    expect(env.act.openIn).toHaveBeenLastCalledWith(OPENERS[2], t.openIn);
    // A stored version opens as a read-only copy, and the tooltip says so.
    expect(find(sub.rows, 'Open in VS Code').tooltip).toMatch(/read-only copy/);
    const wip = file(target({ sha: null, openIn: { ...t.openIn, source: { kind: 'worktree', worktree: '/r' } } }), env).find((r) => r.kind === 'submenu') as Submenu;
    expect(find(wip.rows, 'Open in VS Code').tooltip).not.toMatch(/read-only/);
  });

  it('Open in ▸ while the openers load, after a failed load, and with none found', () => {
    const loading = file(target(), envOf({ openers: { list: null, error: null, last: null } })).find((r) => r.kind === 'submenu') as Submenu;
    expect(labels(loading.rows)).toEqual(['Looking for editors…']);
    expect((loading.rows[0] as Action).disabledReason).toBeTruthy();
    const failed = file(target(), envOf({ openers: { list: null, error: 'no session bus', last: null } })).find((r) => r.kind === 'submenu') as Submenu;
    expect((failed.rows[0] as Action).disabledReason).toBe("Couldn't list editors: no session bus");
    const none = file(target(), envOf({ openers: { list: [], error: null, last: null } })).find((r) => r.kind === 'submenu') as Submenu;
    expect(labels(none.rows)).toEqual(['No editor or file manager found']);
  });

  it('Open diff and View file open the row in the center panel', () => {
    const env = envOf();
    const rows = file(target(), env);
    find(rows, 'Open diff').run();
    expect(env.act.openDiff).toHaveBeenLastCalledWith(diff);
    find(rows, 'View file at this commit').run();
    expect(env.act.viewFile).toHaveBeenLastCalledWith(diff);
  });

  it('an unchanged file has no diff; a working-tree file is "View file"', () => {
    expect(find(file(target({ changed: false }), envOf()), 'Open diff').disabledReason).toBe('Unchanged in this commit');
    const wip = file(target({ sha: null }), envOf());
    expect(labels(wip)).toContain('View file');
    expect(labels(wip)).not.toContain('View file at this commit');
    expect(find(file(target({ deleted: true }), envOf()), 'View file at this commit').tooltip).toBe('Show the whole file as it was before this commit deleted it');
    // Compared with the working tree, the file is gone from disk, not deleted by the commit.
    expect(find(file(target({ deleted: true, list: 'worktree' }), envOf()), 'View file at this commit').tooltip).toBe(`Show the whole file as it was at ${shortSha(sha)}, before it was deleted from the working tree`);
    expect(find(file(target({ deleted: true, list: 'compare' }), envOf()), 'View file at this commit').tooltip).toBe(`Show the whole file as it was at ${shortSha(sha)}, before it was deleted`);
  });

  it('the folder menu: Copy path | Rel | Abs |, and Open in ▸ with the file managers only', () => {
    const env = envOf();
    const t = { path: 'src/lib', root: '/wt', openIn: { worktree: '/wt', path: 'src/lib/a.php', line: null, source: null, fallback: null } };
    const rows = buildMenu<FolderTarget, MenuEnv>('folder', t, env);
    expect(labels(rows)).toEqual(['Copy path', '---', 'Open in']);
    variant(find(rows, 'Copy path'), 'abs').run();
    expect(env.act.copy).toHaveBeenLastCalledWith('/wt/src/lib');
    const sub = rows.find((r) => r.kind === 'submenu') as Submenu;
    expect(labels(sub.rows)).toEqual(['Show in Files']);
    expect(find(sub.rows, 'Show in Files').tooltip).toBe('Show the folder in Files');
    find(sub.rows, 'Show in Files').run();
    expect(env.act.openIn).toHaveBeenLastCalledWith(OPENERS[2], t.openIn);
    const none = buildMenu<FolderTarget, MenuEnv>('folder', t, envOf({ openers: { list: [OPENERS[0]], error: null, last: null } }));
    expect(labels((none.find((r) => r.kind === 'submenu') as Submenu).rows)).toEqual(['No file manager found']);
  });
});

// Plan 1C Task 15 (lane W2-D): the commit, tag and Monaco kinds. `builders never touch the
// backend` above already covers every kind through the throwing `api` proxy; these pin the rows.

const branch = (name: string, local: string | null, ...remotes: Array<{ remote: string; branch: string }>): CommitTarget['branch'] => ({
  name, local, remotes: remotes.map((r) => ({ fullName: `refs/remotes/${r.remote}/${r.branch}`, remote: r.remote })),
});
const commitTarget = (over: Partial<CommitTarget> = {}): CommitTarget => ({ sha, mrRefs: [], isWip: false, branch: null, ...over });
const commit = (t: CommitTarget, env: MenuEnv) => buildMenu<CommitTarget, MenuEnv>('commit', t, env);

describe('the commit menu (spec §7 target table; plan 1C Task 15, commit kind)', () => {
  it('a branch tip: forge refs, then copy (branch name, SHA, message, Forge link), then view; every row has an icon and a tooltip', () => {
    const t = commitTarget({ mrRefs: ['acme/shop!1187', '#3'], branch: branch('feature/x', 'refs/heads/feature/x', { remote: 'origin', branch: 'feature/x' }) });
    const rows = commit(t, envOf());
    expect(labels(rows)).toEqual(['Open acme/shop!1187', '---', 'Copy branch name', 'Copy SHA', 'Copy message', 'Forge link', '---', 'Compare with HEAD']);
    const all = (rs: MenuRow[]): Array<Exclude<MenuRow, { kind: 'separator' }>> => rs.flatMap((r) => (r.kind === 'separator' ? [] : r.kind === 'submenu' ? [r, ...all(r.rows)] : [r]));
    for (const r of all(rows)) {
      expect(r.icon, r.id).toBeTruthy();
      expect(r.tooltip.length, r.id).toBeGreaterThan(3);
      if (r.kind === 'action') for (const v of r.variants ?? []) expect(v.tooltip.length, v.id).toBeGreaterThan(3);
    }
  });

  it('a plain commit (no branch): no branch-name row, Compare with working tree, no forge refs row without a forge', () => {
    const t = commitTarget({ mrRefs: ['!1'] });
    const rows = commit(t, envOf({ forge: () => null }));
    expect(labels(rows)).toEqual(['Copy SHA', 'Copy message', '---', 'Compare with working tree']);
  });

  it('a WIP row gets no commit menu at all', () => {
    expect(commit(commitTarget({ isWip: true }), envOf())).toEqual([]);
  });

  it('Copy branch name | Local | Remote |, greying out what the branch lacks', () => {
    const env = envOf();
    const t = commitTarget({ branch: branch('topic', null, { remote: 'origin', branch: 'topic' }) });
    const row = find(commit(t, env), 'Copy branch name');
    row.run();
    expect(env.act.copy).toHaveBeenLastCalledWith('topic');
    expect(variant(row, 'local').disabledReason).toBe('No local branch');
    variant(row, 'remote').run();
    expect(env.act.copy).toHaveBeenLastCalledWith('origin/topic');
    const local = commitTarget({ branch: branch('topic', 'refs/heads/topic') });
    expect(variant(find(commit(local, env), 'Copy branch name'), 'remote').disabledReason).toBe('Not on a remote');
  });

  it('Copy SHA | Short | Full |, and Copy message loads then copies the full message', () => {
    const env = envOf();
    const row = find(commit(commitTarget(), env), 'Copy SHA');
    variant(row, 'short').run();
    expect(env.act.copy).toHaveBeenLastCalledWith(shortSha(sha));
    row.run();
    expect(env.act.copy).toHaveBeenLastCalledWith(sha);
    find(commit(commitTarget(), env), 'Copy message').run();
    expect(env.act.copyMessage).toHaveBeenLastCalledWith(sha);
  });

  it('Forge link on a branch tip: the label copies the branch link, ⎇/◉ copy theirs, Open opens; a branch off the remote greys out ⎇', () => {
    const env = envOf();
    const t = commitTarget({ branch: branch('feature/x', 'refs/heads/feature/x', { remote: 'origin', branch: 'feature/x' }) });
    const row = find(commit(t, env), 'Forge link');
    const branchUrl = 'https://gitlab.example.com/acme/shop/-/tree/feature/x';
    const permalink = `https://gitlab.example.com/acme/shop/-/commit/${sha}`;
    row.run();
    expect(env.act.copy).toHaveBeenLastCalledWith(branchUrl);
    variant(row, 'commit').run();
    expect(env.act.copy).toHaveBeenLastCalledWith(permalink);
    variant(row, 'open').run();
    expect(env.act.openUrl).toHaveBeenLastCalledWith(branchUrl);
    const local = commitTarget({ branch: branch('local-only', 'refs/heads/local-only') });
    expect(variant(find(commit(local, env), 'Forge link'), 'branch').disabledReason).toBe("This branch isn't on the remote");
  });

  it('Forge link on a plain commit: the permalink, no ⎇ ("right-click a branch label")', () => {
    const env = envOf();
    const row = find(commit(commitTarget(), env), 'Forge link');
    expect(variant(row, 'branch').disabledReason).toBe('Right-click a branch label for its page');
    row.run();
    expect(env.act.copy).toHaveBeenLastCalledWith(`https://gitlab.example.com/acme/shop/-/commit/${sha}`);
  });

  it("Compare with HEAD is disabled at HEAD; Compare with working tree always runs", () => {
    const env = envOf({ headSha: sha });
    const t = commitTarget({ branch: branch('main', 'refs/heads/main') });
    expect(find(commit(t, env), 'Compare with HEAD').disabledReason).toBe('Already at HEAD');
    const env2 = envOf();
    find(commit(commitTarget(), env2), 'Compare with working tree').run();
    expect(env2.act.compare).toHaveBeenLastCalledWith(sha, 'worktree');
  });

  it("open refs: GitLab's !, and its own # issues get no button; GitHub's # opens a pull request, its ! is ignored", () => {
    const t = commitTarget({ mrRefs: ['acme/shop!1187', '#12'] });
    expect(labels(commit(t, envOf()))).toContain('Open acme/shop!1187');
    expect(labels(commit(t, envOf()))).not.toContain('Open #12');
    const ght = commitTarget({ mrRefs: ['#12', '!3'] });
    const rows = commit(ght, envOf({ forge: () => github }));
    expect(labels(rows)).toContain('Open #12');
    expect(labels(rows)).not.toContain('Open !3');
    find(rows, 'Open #12').run();
  });
});

const tagTarget = (over: Partial<TagTarget> = {}): TagTarget => ({ name: 'v1.0', fullName: 'refs/tags/v1.0', sha, ...over });

describe('the tag menu (fix round 1, item 5: spec §7 ruling — copy, then forge)', () => {
  it('Copy tag name, then Forge link; no forge row without a forge', () => {
    const env = envOf();
    const rows = buildMenu<TagTarget, MenuEnv>('tag', tagTarget(), env);
    expect(labels(rows)).toEqual(['Copy tag name', '---', 'Forge link']);
    find(rows, 'Forge link').run();
    expect(env.act.copy).toHaveBeenLastCalledWith('https://gitlab.example.com/acme/shop/-/tree/v1.0');
    variant(find(rows, 'Forge link'), 'open').run();
    expect(env.act.openUrl).toHaveBeenLastCalledWith('https://gitlab.example.com/acme/shop/-/tree/v1.0');
    find(rows, 'Copy tag name').run();
    expect(env.act.copy).toHaveBeenLastCalledWith('v1.0');
    expect(labels(buildMenu<TagTarget, MenuEnv>('tag', tagTarget(), envOf({ forge: () => null })))).toEqual(['Copy tag name']);
  });
});

const monacoTarget = (over: Partial<MonacoTarget> = {}): MonacoTarget => ({
  path: 'src/a.php', sha, lines: [3, 3], selectionText: '', upstream: { remote: 'origin', branch: 'main' },
  openIn: { worktree: '/r', path: 'src/a.php', line: 3, source: { kind: 'atCommit', commit: sha }, fallback: null }, ...over,
});
const monaco = (t: MonacoTarget, env: MenuEnv) => buildMenu<MonacoTarget, MenuEnv>('monaco', t, env);

describe('the Monaco menu (1B GROUP_ORDER.monaco: copy, forge, open)', () => {
  it('rows in order; Copy is disabled with nothing selected', () => {
    const rows = monaco(monacoTarget(), envOf());
    expect(labels(rows)).toEqual(['Copy', 'Copy location', '---', 'Forge link', '---', 'Open in']);
    expect(find(rows, 'Copy').disabledReason).toBe('Nothing selected');
  });

  it('Copy copies the selection; Copy location | rel | Abs |', () => {
    const env = envOf();
    const t = monacoTarget({ selectionText: 'const x = 1;', lines: [3, 5] });
    const rows = monaco(t, env);
    find(rows, 'Copy').run();
    expect(env.act.copy).toHaveBeenLastCalledWith('const x = 1;');
    const loc = find(rows, 'Copy location');
    loc.run();
    expect(env.act.copy).toHaveBeenLastCalledWith('src/a.php:3-5');
    variant(loc, 'abs').run();
    expect(env.act.copy).toHaveBeenLastCalledWith('/r/src/a.php:3-5');
  });

  it('Forge link carries the line anchor; no known upstream greys out ⎇, the permalink still works', () => {
    const env = envOf();
    const withUpstream = find(monaco(monacoTarget(), env), 'Forge link');
    withUpstream.run();
    expect(env.act.copy).toHaveBeenLastCalledWith(`https://gitlab.example.com/acme/shop/-/blob/main/src/a.php#L3`);
    const none = find(monaco(monacoTarget({ upstream: null }), env), 'Forge link');
    expect(variant(none, 'branch').disabledReason).toBe("The commit's branch has no known upstream");
    variant(none, 'commit').run();
    expect(env.act.copy).toHaveBeenLastCalledWith(`https://gitlab.example.com/acme/shop/-/blob/${sha}/src/a.php#L3`);
  });

  it('Open in ▸ opens the target at the clicked line', () => {
    const env = envOf({ openers: { list: OPENERS, error: null, last: null } });
    const t = monacoTarget();
    const sub = monaco(t, env).find((r) => r.kind === 'submenu') as Submenu;
    find(sub.rows, 'Open in VS Code').run();
    expect(env.act.openIn).toHaveBeenLastCalledWith(OPENERS[0], t.openIn);
  });
});
