import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeKind } from '../api/gen/ForgeKind';
import type { ForgeMr } from '../api/gen/ForgeMr';
import type { MenuEnv, MrTarget } from '../menu/menuEnv';
import type { MenuRow } from '../menu/types';

// Menus are built synchronously from memory (spec §7): a builder that touched the backend would
// hit this proxy and throw.
vi.mock('../api/client', () => ({ api: new Proxy({}, { get() { throw new Error('menu builders must never call the backend'); } }), errorMessage: String }));
const checkout = vi.hoisted(() => ({ checkoutMr: vi.fn(async () => {}), checkoutMrInWorktree: vi.fn(async () => {}) }));
vi.mock('./mrview/checkout', async (importOriginal) => ({ ...(await importOriginal<typeof import('./mrview/checkout')>()), ...checkout }));
const writes = vi.hoisted(() => ({ toggleMrDraft: vi.fn(async () => true) }));
vi.mock('./mrview/writes', () => writes);
const poll = vi.hoisted(() => ({ openMrView: vi.fn() }));
vi.mock('./poll', () => poll);

const { buildMenu } = await import('../menu/registry');
const { NOT_LOCAL } = await import('./mrMenu');
const { patchForge, useForge } = await import('./mrStore');
const { useRuntime } = await import('../app/runtime');
const { mrOf, projectOf } = await import('./testMrs');

type Action = Extract<MenuRow, { kind: 'action' }>;
const act = () => ({ copy: vi.fn(), openUrl: vi.fn(), openIn: vi.fn(), openDiff: vi.fn(), viewFile: vi.fn(), compare: vi.fn(), copyMessage: vi.fn(), showInGraph: vi.fn(), openFolder: vi.fn() });
const envOf = (over: Partial<MenuEnv> = {}): MenuEnv => ({ forge: () => null, openers: { list: [], error: null, last: null }, act: act(), headBranch: 'main', headSha: null, inGraph: () => true, write: null, sidebar: null, labelsAt: () => [], activeWorktree: null, mainWorktree: null, inProgress: null, worktreeShown: (p) => `../${p.split('/').pop()}`, ...over });
const labels = (rows: MenuRow[]) => rows.map((r) => (r.kind === 'separator' ? '---' : r.label));
const find = (rows: MenuRow[], id: string) => rows.find((r) => r.kind === 'action' && r.id === id) as Action;
const menu = (mr: ForgeMr, env = envOf(), forge: ForgeKind = 'gitlab') => buildMenu<MrTarget, MenuEnv>('mr', { tabId: 't', mr, forge }, env);

type Local = { name: string; upstream: string | null; isHead?: boolean; checkedOut?: string | null };
function tab(kind: ForgeKind, locals: Local[] = [], me: string | null = null) {
  const host = kind === 'gitlab' ? 'gitlab.example.com' : 'github.com';
  const info = { remotes: [{ name: 'origin', url: `https://${host}/group/project.git`, host, path: 'group/project', hostKind: kind }] };
  useRuntime.setState({ tabs: { t: { repo: { id: 4 }, info, sidebar: { locals: locals.map((l) => ({ checkedOut: null, ...l })), remotes: [], worktrees: [], stashes: [], tags: [] } } as never } });
  useForge.setState({ byTab: {} });
  patchForge('t', { kind, remote: 'origin', project: projectOf('group/project', kind), me });
}
const gh = (n: number, over: Partial<ForgeMr> = {}) => mrOf(n, { webUrl: `https://github.com/group/project/pull/${n}`, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  tab('gitlab');
});

describe("a sidebar MR/PR row's menu", () => {
  it('GitLab: groups in order, merge-request wording; every row has an icon and a tooltip', () => {
    const rows = menu(mrOf(12));
    expect(labels(rows)).toEqual(['Open merge request', '---', 'Check out', 'Check out in a new worktree…', '---', 'Show in graph', '---', 'Copy link', 'Copy branch name', 'Copy number']);
    for (const r of rows) {
      if (r.kind !== 'action') continue;
      expect(r.icon, r.id).toBeTruthy();
      expect(r.tooltip.length, r.id).toBeGreaterThan(3);
      for (const v of r.variants ?? []) expect(v.tooltip.length, v.id).toBeGreaterThan(3);
    }
    const env = envOf();
    find(menu(mrOf(12), env), 'mr.copyNumber').run();
    expect(env.act.copy).toHaveBeenLastCalledWith('!12');
    expect(find(rows, 'mr.open').tooltip).toContain('!12');
  });

  it('GitHub: pull-request wording and #12', () => {
    tab('github');
    const env = envOf();
    const rows = menu(gh(12), env, 'github');
    expect(labels(rows)[0]).toBe('Open pull request');
    find(rows, 'mr.copyNumber').run();
    expect(env.act.copy).toHaveBeenLastCalledWith('#12');
    expect(find(rows, 'mr.copyLink').variants![0].tooltip).toBe('Open #12 on GitHub in the browser');
  });

  it('Open opens the MR view, as a click on the row does', () => {
    find(menu(mrOf(12)), 'mr.open').run();
    expect(poll.openMrView).toHaveBeenCalledWith('t', 12);
  });

  it("Check out: the fork's label (no remote for it yet), or plain Check out from an existing remote", () => {
    const fork = mrOf(14, { sourceProject: 'alice/project', sourceBranch: 'fix' });
    const row = find(menu(fork), 'mr.checkout');
    expect(row.label).toBe("Add alice's fork and check out");
    expect(row.disabledReason).toBeUndefined();
    expect(row.tooltip).toContain('adding the fork as a remote first');
    expect(find(menu(fork), 'mr.checkoutWorktree').tooltip).toContain('adding the fork as a remote first');
    const plain = find(menu(mrOf(12)), 'mr.checkout');
    expect(plain.label).toBe('Check out');
    plain.run();
    expect(checkout.checkoutMr).toHaveBeenCalledWith('t', mrOf(12));
    find(menu(mrOf(12)), 'mr.checkoutWorktree').run();
    expect(checkout.checkoutMrInWorktree).toHaveBeenCalledWith('t', mrOf(12));
  });

  it("is disabled when it's already checked out, here (Checked out) or in a worktree", () => {
    tab('gitlab', [{ name: 'dev', upstream: 'refs/remotes/origin/dev', isHead: true, checkedOut: '/repos/project' }]);
    const rows = menu(mrOf(12));
    expect(find(rows, 'mr.checkout')).toMatchObject({ label: 'Checked out', disabledReason: 'dev is checked out', tooltip: 'dev is checked out' });
    expect(find(rows, 'mr.checkoutWorktree').disabledReason).toBe('dev is checked out in ../project');
    tab('gitlab', [{ name: 'dev', upstream: 'refs/remotes/origin/dev', checkedOut: '/repos/project-dev' }]);
    const other = menu(mrOf(12));
    expect(find(other, 'mr.checkout').disabledReason).toBeUndefined();
    expect(find(other, 'mr.checkoutWorktree').disabledReason).toBe('dev is checked out in ../project-dev');
  });

  it("is disabled when the source project isn't readable", () => {
    const rows = menu(mrOf(14, { sourceProject: '' }));
    expect(find(rows, 'mr.checkout').disabledReason).toBe("The source project isn't readable");
    expect(find(rows, 'mr.checkoutWorktree').disabledReason).toBe("The source project isn't readable");
  });

  it('Copy link copies the web address; its Open variant opens it', () => {
    const env = envOf();
    const row = find(menu(mrOf(12), env), 'mr.copyLink');
    row.run();
    expect(env.act.copy).toHaveBeenLastCalledWith(mrOf(12).webUrl);
    row.variants!.find((v) => v.id === 'open')!.run();
    expect(env.act.openUrl).toHaveBeenLastCalledWith(mrOf(12).webUrl);
  });

  it('Copy branch name: the source branch; from a fork, an owner:branch variant', () => {
    const env = envOf();
    const own = find(menu(mrOf(12), env), 'mr.copyBranch');
    own.run();
    expect(env.act.copy).toHaveBeenLastCalledWith('dev');
    expect(own.variants).toBeUndefined();
    const fork = find(menu(mrOf(14, { sourceProject: 'alice/project', sourceBranch: 'fix' }), env), 'mr.copyBranch');
    fork.variants!.find((v) => v.id === 'owner')!.run();
    expect(env.act.copy).toHaveBeenLastCalledWith('alice:fix');
  });

  it('Show in graph selects the head commit; disabled when that commit is unknown here', () => {
    const env = envOf({ inGraph: () => false });
    const off = find(menu(mrOf(12), env), 'mr.showInGraph');
    expect(off.disabledReason).toBe(NOT_LOCAL);
    expect(find(menu(mrOf(12, { headSha: null })), 'mr.showInGraph').disabledReason).toBe(NOT_LOCAL);
    const on = envOf();
    const row = find(menu(mrOf(12), on), 'mr.showInGraph');
    expect(row.disabledReason).toBeUndefined();
    row.run();
    expect(on.act.showInGraph).toHaveBeenCalledWith(mrOf(12).headSha);
  });

  it("draft ⇄ ready: only for the author's own open or draft one", () => {
    expect(find(menu(mrOf(12)), 'mr.draft')).toBeUndefined(); // nobody signed in
    tab('gitlab', [], 'ada');
    expect(find(menu(mrOf(12)), 'mr.draft')).toBeUndefined(); // someone else's
    tab('gitlab', [], 'grace');
    const open = find(menu(mrOf(12)), 'mr.draft');
    expect(open.label).toBe('Convert to draft');
    expect(labels(menu(mrOf(12))).slice(-2)).toEqual(['---', 'Convert to draft']);
    open.run();
    expect(writes.toggleMrDraft).toHaveBeenCalledWith('t', 'gitlab', mrOf(12));
    expect(find(menu(mrOf(5, { state: 'draft' })), 'mr.draft').label).toBe('Mark as ready');
    expect(find(menu(mrOf(6, { state: 'merged' })), 'mr.draft')).toBeUndefined();
  });
});
