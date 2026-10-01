import { describe, expect, it } from 'vitest';
import type { SidebarPayload } from '../api/gen/SidebarPayload';
import { buildRows, folderKey, sectionKey, sectionsOf, type FlatRow } from './model';

const branch = (name: string, tipTime: number, extra: object = {}) => ({ name, fullName: `refs/heads/${name}`, target: name.padEnd(40, '0'), upstream: null, ahead: 0, behind: 0, gone: false, tipTime, summary: `tip of ${name}`, author: 'Ada', isHead: false, worktree: null, ...extra });
const payload: SidebarPayload = {
  locals: [branch('feature/login', 30), branch('feature/pay/v2', 10), branch('main', 20, { isHead: true })],
  remotes: [{ name: 'origin', hostKind: 'gitlab', branches: [{ name: 'main', fullName: 'refs/remotes/origin/main', target: 'm'.repeat(40), tipTime: 20, summary: 's', author: 'a' }] }],
  worktrees: [{ path: '/r', name: 'r', branch: 'main', head: 'h'.repeat(40), isMain: true, isCurrent: true }],
  stashes: [{ index: 0, id: 's'.repeat(40), message: 'On main: wip', time: 5 }],
  tags: [{ name: 'v1.0', fullName: 'refs/tags/v1.0', target: 't'.repeat(40), time: 1 }],
};
const view = (rows: FlatRow[]) => rows.map((r) => (r.type === 'section' ? `[${r.section.label} ${r.filtering ? `${r.matched}/${r.total}` : r.total}]` : `${'  '.repeat(r.depth)}${r.type === 'folder' ? `${r.name}/` : r.label}`));
const opts = (o: Partial<Parameters<typeof buildRows>[1]> = {}) => ({ filter: '', sort: {}, collapsed: new Set<string>(), ...o });

describe('sidebar model', () => {
  it('nests by "/" with folders first, in section order', () => {
    expect(view(buildRows(sectionsOf(payload), opts()))).toEqual([
      '[Local 3]', '  feature/', '    pay/', '      v2', '    login', '  main',
      '[origin 1]', '  main',
      '[Worktrees 1]', '  r',
      '[Stashes 1]', '  On main: wip',
      '[Tags 1]', '  v1.0',
    ]);
  });

  it('filters case-insensitively, keeps parents, forces them open, counts matched/total', () => {
    const rows = buildRows(sectionsOf(payload), opts({ filter: 'LOGIN', collapsed: new Set([folderKey('local', 'feature')]) }));
    expect(view(rows)).toEqual(['[Local 1/3]', '  feature/', '    login', '[origin 0/1]', '[Worktrees 0/1]', '[Stashes 0/1]', '[Tags 0/1]']);
  });

  it('collapsed folders and sections hide their contents', () => {
    const rows = buildRows(sectionsOf(payload), opts({ collapsed: new Set([folderKey('local', 'feature'), sectionKey('tags')]) }));
    expect(view(rows).slice(0, 3)).toEqual(['[Local 3]', '  feature/', '  main']);
    expect(view(rows).at(-1)).toBe('[Tags 1]');
  });

  it('recent sort is flat and newest first', () => {
    const rows = buildRows(sectionsOf(payload), opts({ sort: { local: 'recent' } }));
    expect(view(rows).slice(0, 4)).toEqual(['[Local 3]', '  feature/login', '  main', '  feature/pay/v2']);
  });
});
