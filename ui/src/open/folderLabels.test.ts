import { describe, expect, it } from 'vitest';
import { folderLabels, folderOf } from './folderLabels';

describe('folderLabels', () => {
  it('names each directory by its shortest trailing path no other shares', () => {
    expect([...folderLabels(['/home/u/repos', '/home/u/work/']).values()]).toEqual(['repos', 'work']);
    expect([...folderLabels(['/home/u/a/src', '/home/u/b/src', '/opt/tools']).values()]).toEqual(['a/src', 'b/src', 'tools']);
    expect([...folderLabels(['C:\\Users\\u\\repos']).values()]).toEqual(['repos']);
    expect([...folderLabels(['/']).values()]).toEqual(['/']);
  });
});

describe('folderOf', () => {
  it('picks the deepest scanned directory containing the path, by whole segments', () => {
    const folders = ['/home/u/repos', '/home/u/repos/work/', '/home/u/rep'];
    expect(folderOf('/home/u/repos/one', folders)).toBe('/home/u/repos');
    expect(folderOf('/home/u/repos/work/two', folders)).toBe('/home/u/repos/work/');
    expect(folderOf('/home/u/rep/x', folders)).toBe('/home/u/rep');
    expect(folderOf('/elsewhere/x', folders)).toBeUndefined();
  });
});
