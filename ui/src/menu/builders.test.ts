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

import type { FileTarget, FolderTarget, MenuEnv } from './menuEnv';

type Action = Extract<MenuRow, { kind: 'action' }>;
type Submenu = Extract<MenuRow, { kind: 'submenu' }>;

const OPENERS: OpenerPayload[] = [
  { id: 'vscode', name: 'VS Code', kind: 'editor' },
  { id: 'jetbrains-phpstorm', name: 'PhpStorm', kind: 'editor' },
  { id: 'file-manager', name: 'Files', kind: 'fileManager' },
  { id: 'other', name: 'Other…', kind: 'chooser' },
];
const gitlab = { host: 'gitlab.example.com', path: 'acme/shop', hostKind: 'gitlab' as const };
const act = () => ({ copy: vi.fn(), openUrl: vi.fn(), openIn: vi.fn(), openDiff: vi.fn(), viewFile: vi.fn() });
const envOf = (over: Partial<MenuEnv> = {}): MenuEnv => ({ forge: () => gitlab, openers: { list: OPENERS, error: null, last: null }, act: act(), ...over });
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
