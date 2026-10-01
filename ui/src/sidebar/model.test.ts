import { describe, expect, it } from 'vitest';
import type { SidebarPayload } from '../api/gen/SidebarPayload';
import { buildPanels, folderKey, sectionKey, sectionsOf, type Panel } from './model';

const branch = (name: string, tipTime: number, extra: object = {}) => ({ name, fullName: `refs/heads/${name}`, target: name.padEnd(40, '0'), upstream: null, ahead: 0, behind: 0, gone: false, tipTime, summary: `tip of ${name}`, author: 'Ada', isHead: false, worktree: null, ...extra });
const payload: SidebarPayload = {
  locals: [branch('feature/login', 30), branch('feature/pay/v2', 10), branch('main', 20, { isHead: true })],
  remotes: [{ name: 'origin', hostKind: 'gitlab', branches: [{ name: 'main', fullName: 'refs/remotes/origin/main', target: 'm'.repeat(40), tipTime: 20, summary: 's', author: 'a' }] }],
  worktrees: [{ path: '/r', name: 'r', branch: 'main', head: 'h'.repeat(40), isMain: true, isCurrent: true }],
  stashes: [{ index: 0, id: 's'.repeat(40), message: 'On main: wip', time: 5 }],
  tags: [{ name: 'v1.0', fullName: 'refs/tags/v1.0', target: 't'.repeat(40), time: 1 }],
};
const view = (panels: Panel[]) => panels.flatMap((p) => [`[${p.section.label} ${p.matched}${p.collapsed ? ' collapsed' : ''}]`, ...p.rows.map((r) => `${'  '.repeat(r.depth)}${r.type === 'folder' ? `${r.name}/` : r.label}`)]);
const opts = (o: Partial<Parameters<typeof buildPanels>[1]> = {}) => ({ filter: '', sort: {}, collapsed: new Set<string>(), ...o });

describe('sidebar model', () => {
  it('builds one panel per section, in fixed order, nesting by "/", folders and branches in one alphabetical order', () => {
    expect(view(buildPanels(sectionsOf(payload), opts()))).toEqual([
      '[Local 3]', '  feature/', '    login', '    pay/', '      v2', '  main',
      '[Remote 1]', '  origin/', '    main',
      '[Worktrees 1]', '  r',
      '[Stashes 1]', '  On main: wip',
      '[Tags 1]', '  v1.0',
    ]);
  });

  it('a branch sorts among the folders by name: dev comes before the f/ folder', () => {
    const mixed: SidebarPayload = { ...payload, locals: [branch('f/cart-stack', 1), branch('dev', 2), branch('backup/old', 3)] };
    expect(view(buildPanels(sectionsOf(mixed), opts())).slice(0, 6)).toEqual(['[Local 3]', '  backup/', '    old', '  dev', '  f/', '    cart-stack']);
  });

  it('the filter applies to every panel; counts are the matches, a panel with none shows 0', () => {
    const panels = buildPanels(sectionsOf(payload), opts({ filter: 'LOGIN', collapsed: new Set([folderKey('local', 'feature')]) }));
    expect(view(panels)).toEqual(['[Local 1]', '  feature/', '    login', '[Remote 0]', '[Worktrees 0]', '[Stashes 0]', '[Tags 0]']);
    expect(panels.map((p) => p.total)).toEqual([3, 1, 1, 1, 1]);
    expect(panels.every((p) => p.filtering)).toBe(true);
  });

  it('the filter also matches a remote branch by "remote/name"', () => {
    expect(buildPanels(sectionsOf(payload), opts({ filter: 'origin/ma' }))[1].matched).toBe(1);
  });

  it('a collapsed panel keeps its count but has no rows; collapsed folders hide their contents', () => {
    const panels = buildPanels(sectionsOf(payload), opts({ collapsed: new Set([folderKey('local', 'feature'), sectionKey('tags'), sectionKey('remote')]) }));
    expect(view(panels)).toEqual(['[Local 3]', '  feature/', '  main', '[Remote 1 collapsed]', '[Worktrees 1]', '  r', '[Stashes 1]', '  On main: wip', '[Tags 1 collapsed]']);
  });

  it('recent sort is flat and newest first; the remote keeps its group, rows unprefixed (K76)', () => {
    const panels = buildPanels(sectionsOf(payload), opts({ sort: { local: 'recent', remote: 'recent' } }));
    expect(view(panels).slice(0, 7)).toEqual(['[Local 3]', '  feature/login', '  main', '  feature/pay/v2', '[Remote 1]', '  origin/', '    main']);
  });

  it('K76: remote groups order by newest tip, branches inside newest first (ties by name), flat, no prefix', () => {
    const rb = (name: string, tipTime: number, remote: string) => ({ name, fullName: `refs/remotes/${remote}/${name}`, target: 'x'.repeat(40), tipTime, summary: '', author: '' });
    const p: SidebarPayload = { ...payload, remotes: [
      { name: 'origin', hostKind: 'generic', branches: [rb('old', 5, 'origin'), rb('b/deep', 10, 'origin'), rb('a', 10, 'origin')] },
      { name: 'upstream', hostKind: 'generic', branches: [rb('fresh', 50, 'upstream')] },
    ] };
    const panel = buildPanels(sectionsOf(p), opts({ sort: { remote: 'recent' } }))[1];
    expect(view([panel])).toEqual(['[Remote 4]', '  upstream/', '    fresh', '  origin/', '    a', '    b/deep', '    old']);
    const collapsed = buildPanels(sectionsOf(p), opts({ sort: { remote: 'recent' }, collapsed: new Set([folderKey('remote', 'upstream')]) }))[1];
    expect(view([collapsed])).toEqual(['[Remote 4]', '  upstream/', '  origin/', '    a', '    b/deep', '    old']);
  });
});
