import { describe, expect, it } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import { allFolderPaths, buildRows, buildTree, countByStatus, flattenTree, rowIndent, TREE } from './fileTree';

const change = (path: string, status = 'M', oldPath: string | null = null): FileChange => ({
  path, oldPath, status, additions: 1, deletions: 0, old: { kind: 'object', oid: 'a'.repeat(40) }, new: { kind: 'object', oid: 'b'.repeat(40) }, submodule: false,
});
const spec = { kind: 'commit' as const, id: 'c'.repeat(40), parent: 0 };

describe('file tree', () => {
  it('nests folders first, alphabetically, and merges single-child folder chains', () => {
    const tree = buildTree([{ path: 'src/Framework/Orm/Model.php' }, { path: 'src/Framework/Orm/Query.php' }, { path: 'README.md' }, { path: 'docs/a.txt' }]);
    expect(tree.map((n) => n.name)).toEqual(['docs', 'src/Framework/Orm', 'README.md']);
    expect(tree[1].path).toBe('src/Framework/Orm');
    expect(tree[1].children.map((n) => n.name)).toEqual(['Model.php', 'Query.php']);
    const flat = flattenTree(tree, new Set(['docs']));
    expect(flat.map((f) => [f.node.name, f.depth])).toEqual([['docs', 0], ['src/Framework/Orm', 0], ['Model.php', 1], ['Query.php', 1], ['README.md', 0]]);
  });

  it('builds path and tree rows, with unchanged files for View all files', () => {
    const files = [change('src/b.php'), change('a.txt', 'A'), change('docs/new.txt', 'R', 'docs/old.txt')];
    const path = buildRows({ files, spec, unchanged: null, mode: 'path', sort: 'path', collapsed: new Set() });
    expect(path.map((r) => (r.kind === 'file' ? [r.dir, r.name] : r.name))).toEqual([['', 'a.txt'], ['docs', 'new.txt'], ['src', 'b.php']]);
    const byStatus = buildRows({ files, spec, unchanged: null, mode: 'path', sort: 'status', collapsed: new Set() });
    expect(byStatus.map((r) => (r.kind === 'file' ? r.change?.status : ''))).toEqual(['A', 'M', 'R']);
    const all = buildRows({ files, spec, unchanged: { commit: spec.id, paths: ['a.txt', 'z.txt', 'src/b.php'] }, mode: 'path', sort: 'path', collapsed: new Set() });
    const z = all.find((r) => r.kind === 'file' && r.name === 'z.txt');
    expect(z?.kind === 'file' && z.change === null && z.target.view === 'file' && z.target.new).toEqual({ kind: 'atCommit', commit: spec.id });
    const tree = buildRows({ files, spec, unchanged: null, mode: 'tree', sort: 'path', collapsed: new Set(['src']) });
    expect(tree.map((r) => `${r.kind}:${r.name}:${r.depth}`)).toEqual(['folder:docs:0', 'file:new.txt:1', 'folder:src:0', 'file:a.txt:0']);
    expect(allFolderPaths(files, null)).toEqual(['docs', 'src']);
  });

  it('counts by status', () => {
    expect(countByStatus([change('a', 'M'), change('b', 'T'), change('c', 'A'), change('d', 'C'), change('e', 'D'), change('f', 'R')])).toEqual({ modified: 2, added: 2, deleted: 1, renamed: 1, conflicted: 0 });
    // Unmerged and unknown files count as conflicted (StatusIcon's kind), not modified.
    expect(countByStatus([change('a', 'U'), change('b', 'X'), change('c', 'M')])).toEqual({ modified: 1, added: 0, deleted: 0, renamed: 0, conflicted: 2 });
  });

  it('a collapsed folder carries its subtree\'s change counts; an expanded one none (F20)', () => {
    const files = [change('src/a.php'), change('src/lib/b.php', 'A'), change('src/lib/c.php', 'D'), change('src/n.php', 'R', 'src/o.php'), change('top.txt')];
    const unchanged = { commit: spec.id, paths: ['src/zz.php'] };
    const collapsed = buildRows({ files, spec, unchanged, mode: 'tree', sort: 'path', collapsed: new Set(['src']) });
    const src = collapsed.find((r) => r.kind === 'folder' && r.path === 'src');
    // Unchanged files ("View all files") don't count.
    expect(src?.kind === 'folder' && src.counts).toEqual({ modified: 1, added: 1, deleted: 1, renamed: 1, conflicted: 0 });
    const expanded = buildRows({ files, spec, unchanged, mode: 'tree', sort: 'path', collapsed: new Set(['src/lib']) });
    const [srcOpen, lib] = ['src', 'src/lib'].map((p) => expanded.find((r) => r.kind === 'folder' && r.path === p));
    expect(srcOpen?.kind === 'folder' && srcOpen.counts).toBeNull();
    expect(lib?.kind === 'folder' && lib.counts).toEqual({ modified: 0, added: 1, deleted: 1, renamed: 0, conflicted: 0 });
  });

  it('indents one level by exactly the chevron and its gap, so a file\'s icon starts under its folder\'s name (F17)', () => {
    // A folder row is [chevron][gap][name]; a file row is [status icon][gap][name]. Its child
    // row starts one indent further: that is the folder's name offset.
    const folderNameLeft = (depth: number) => rowIndent(depth) + TREE.chevron + TREE.gap;
    for (const d of [0, 1, 2, 5]) expect(rowIndent(d + 1)).toBe(folderNameLeft(d));
    expect(TREE.icon).toBe(TREE.chevron); // sibling folder and file names line up too
    expect(rowIndent(0)).toBe(TREE.base);
  });
});
