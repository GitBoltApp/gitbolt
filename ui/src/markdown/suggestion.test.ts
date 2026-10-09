import { describe, expect, it } from 'vitest';
import type { DiffPosition } from '../api/gen/DiffPosition';
import { linesBase, positionBase, replacedLines, snippetBase, suggestionOffset } from './suggestion';

const file = ['one', 'two', 'three', 'four', 'five', 'six'];
const get = (from: number, to: number) => file.slice(from - 1, to);
const pos = (over: Partial<DiffPosition>): DiffPosition => ({ path: 'src/app.ts', oldPath: null, line: 4, oldLine: null, snippet: null, startLine: null, startOldLine: null, ...over });

describe('a suggestion’s replaced lines (spec 2026-10-08)', () => {
  it("GitLab's -N+M counts from the comment's last line; a plain fence is GitHub's commented lines, GitLab's last line", () => {
    expect(suggestionOffset('suggestion:-2+1', { flavor: 'gitlab', span: 0 })).toEqual({ above: 2, below: 1 });
    expect(suggestionOffset('suggestion', { flavor: 'github', span: 2 })).toEqual({ above: 2, below: 0 });
    expect(suggestionOffset('suggestion', { flavor: 'gitlab', span: 2 })).toEqual({ above: 0, below: 0 });
  });

  it('reads them from the new side’s text; past either end, they’re unknown', () => {
    const base = linesBase('gitlab', null, 3, 4, get);
    expect(replacedLines('suggestion:-1+0', base)).toEqual(['three', 'four']);
    expect(replacedLines('suggestion:-0+2', base)).toEqual(['four', 'five', 'six']);
    expect(replacedLines('suggestion:-1+3', base)).toBeNull();
    expect(replacedLines('suggestion:-4+0', base)).toBeNull();
    expect(replacedLines('suggestion', linesBase('github', null, 3, 4, get))).toEqual(['three', 'four']);
    expect(replacedLines('suggestion', null)).toBeNull();
  });

  it("from a note's position: its range on the new side; a note on a removed line replaces nothing", () => {
    expect(replacedLines('suggestion', positionBase('github', pos({ startLine: 2 }), get))).toEqual(['two', 'three', 'four']);
    expect(replacedLines('suggestion', positionBase('github', pos({}), get))).toEqual(['four']);
    expect(positionBase('github', pos({ line: null, oldLine: 4 }), get)).toBeNull();
    // It carries the file's path: its language highlights the diff.
    expect(positionBase('github', pos({}), get)?.path).toBe('src/app.ts');
    expect(snippetBase('gitlab', pos({ snippet: '+four' }))?.path).toBe('src/app.ts');
    expect(positionBase('github', null, get)).toBeNull();
  });

  it("from a thread's snippet: its new-side lines, prefixes off, ending at the note's line", () => {
    // A range note (GitLab's line_range): the snippet starts at its first line.
    const range = snippetBase('gitlab', pos({ line: 5, startLine: 3, snippet: '-old three\n+three\n four\n+five' }));
    expect(replacedLines('suggestion:-2+0', range)).toEqual(['three', 'four', 'five']);
    expect(replacedLines('suggestion:-1+0', range)).toEqual(['four', 'five']);
    // GitHub's plain fence: the note's own range.
    expect(replacedLines('suggestion', snippetBase('github', pos({ line: 5, startLine: 4, snippet: ' three\n four\n+five' })))).toEqual(['four', 'five']);
    // An empty context line may have lost its space.
    expect(replacedLines('suggestion:-1+0', snippetBase('gitlab', pos({ line: 2, snippet: '\n+two' })))).toEqual(['', 'two']);
  });

  it('a snippet too short for the offsets, a note on a removed line, or none: unknown', () => {
    const short = snippetBase('gitlab', pos({ line: 5, snippet: ' four\n+five' }));
    expect(replacedLines('suggestion:-1+0', short)).toEqual(['four', 'five']);
    expect(replacedLines('suggestion:-2+0', short)).toBeNull();
    // The snippet ends at the note's line: nothing below it.
    expect(replacedLines('suggestion:-0+1', short)).toBeNull();
    expect(snippetBase('gitlab', pos({ line: null, oldLine: 3, snippet: ' two\n-three' }))).toBeNull();
    expect(snippetBase('gitlab', pos({ snippet: null }))).toBeNull();
  });
});
