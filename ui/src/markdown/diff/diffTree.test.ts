import type { Definition, Heading, List, ListItem, Nodes, Root, Table } from 'mdast';
import { visit } from 'unist-util-visit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { splitChunks } from '../chunks';
import { clearParseCache, parseMarkdown } from '../parse';
import { plainText } from './blocks';
import { diffMarkdown, diffTrees } from './diffTree';
import type { DiffBlockNode } from './nodes';

const d = (a: string, b: string) => { clearParseCache(); return diffMarkdown(a, b, 'github'); };
/** Every mark in document order: blocks by kind, words by text, items and rows, code line marks. */
function summary(root: Root): string[] {
  const out: string[] = [];
  visit(root, (n: Nodes) => {
    if (n.type === 'diffBlock') out.push(`${n.mark}:${n.children.map((c) => c.type).join(',')}`);
    else if (n.type === 'diffPair') out.push('pair');
    else if (n.type === 'diffIns') out.push(`ins:${plainText(n)}`);
    else if (n.type === 'diffDel') out.push(`del:${plainText(n)}`);
    else if (n.type === 'listItem' && n.data?.gbDiff) out.push(`item:${n.data.gbDiff}:${plainText(n)}`);
    else if (n.type === 'tableRow' && n.data?.gbDiff) out.push(`row:${n.data.gbDiff}`);
    else if (n.type === 'code' && n.data?.gbLines) out.push(`lines:${n.data.gbLines}`);
  });
  return out;
}

describe('diffMarkdown (5C)', () => {
  it('a changed heading and paragraph show their word changes in changed blocks', () => {
    const r = d('# Setup guide\n\nRun the tool once.\n', '# Install guide\n\nRun the tool twice.\n');
    expect(summary(r.root)).toEqual(['changed:heading', 'del:Setup', 'ins:Install', 'changed:paragraph', 'del:once', 'ins:twice']);
    expect(r.changes).toBe(2);
    expect(r.root.data?.gbChanges).toBe(2);
  });

  it('a heading that lost words is one changed heading, its removed words marked', () => {
    const r = d('## Windows (in progress)\n\nThe app builds.\n', '## Windows\n\nThe app builds.\n');
    expect(summary(r.root)).toEqual(['changed:heading', 'del: (in progress)']);
    expect(r.changes).toBe(1);
  });

  it('short list items pair by a shared word or a prefix, unrelated ones do not', () => {
    expect(summary(d('- Install\n- Gamma steps\n', '- Installing\n- Delta stage\n').root))
      .toEqual(['item:changed:InstallInstalling', 'del:Install', 'ins:Installing', 'item:removed:Gamma steps', 'item:added:Delta stage']);
  });

  it('an added list item is marked in place, inside the one list', () => {
    const r = d('- install\n- configure\n', '- install\n- configure\n- verify\n');
    expect(summary(r.root)).toEqual(['item:added:verify']);
    expect(r.root.children[0]!.type).toBe('list');
  });

  it('an ordered list keeps its numbers: a removed item keeps its old one (R12)', () => {
    const list = d('1. alpha\n2. beta\n3. gamma\n', '1. alpha\n2. gamma\n').root.children[0] as List;
    expect(list.children.map((i) => [plainText(i), i.data?.gbDiff ?? null, i.data?.gbValue])).toEqual([['alpha', null, 1], ['beta', 'removed', 2], ['gamma', null, 2]]);
  });

  describe('a changed list item pairs and word-diffs, its neighbours changed too', () => {
    const list = (log: string, tail: string) => [
      '- **Event feed:** every finished sync, newest first. Since 2B, the same panel is the Trace panel.',
      `- **${log}:** \`~/.cache/demoapp/logs/app.log\` (7 days). A sync still running shows "Syncing <repo>… N%"${tail}.`,
      '- **Test server:** `demoapp-test serve` exposes the test-only routes `/test/reset` and `/test/emit`.',
      '',
    ].join('\n');
    const newList = list('Log files', ' with Cancel').replace('Since 2B, the same panel is the', 'The same panel is also the').replace('and `/test/emit`', '`/test/emit` and `/test/write`');

    it('with a placeholder tag (`<repo>`) in it: the words around it diff (R13)', () => {
      expect(summary(d(list('Log files (2B)', ''), newList).root)).toEqual([
        'item:changed:Event feed: every finished sync, newest first. SinceThe 2B, the same panel is also the Trace panel.', 'del:Since', 'ins:The', 'del:2B, the ', 'ins:also ',
        'item:changed:Log files (2B): ~/.cache/demoapp/logs/app.log (7 days). A sync still running shows "Syncing <repo>… N%" with Cancel.', 'del: (2B)', 'ins: with Cancel',
        'item:changed:Test server: demoapp-test serve exposes the test-only routes /test/reset /test/emit and /test/emit/test/write.', 'ins:/test/emit ', 'del:/test/emit', 'ins:/test/write',
      ]);
    });

    it('with a changed strong label', () => {
      const r = d('- **Alpha:** one.\n- **Log files (2B):** written daily, kept 7 days.\n- **Gamma:** three.\n', '- **Alpha:** uno.\n- **Log files:** written daily, kept 7 days.\n- **Gamma:** tres.\n');
      expect(summary(r.root)).toEqual([
        'item:changed:Alpha: oneuno.', 'del:one', 'ins:uno',
        'item:changed:Log files (2B): written daily, kept 7 days.', 'del: (2B)',
        'item:changed:Gamma: threetres.', 'del:three', 'ins:tres',
      ]);
    });

    it('with changed emphasis, inline code and links', () => {
      const r = d('- see *old* `a()` at [docs](a.md) today\n- b\n', '- see *new* `b()` at [guide](a.md) today\n- c\n');
      expect(summary(r.root)).toEqual(['item:changed:see oldnew a()b() at docsguide today', 'del:old', 'ins:new', 'del:a()', 'ins:b()', 'del:docs', 'ins:guide', 'item:removed:b', 'item:added:c']);
    });
  });

  it('an item that grew a lot pairs: the added text shows as insertions', () => {
    const r = d('1. Install it.\n2. Run the installer, then launch the app from the menu.\n', '1. Install it.\n2. Run the installer, then launch the app from the menu. The package name carries a build stamp, so the pattern matches only the new one.\n');
    expect(summary(r.root)).toEqual(['item:changed:Run the installer, then launch the app from the menu. The package name carries a build stamp, so the pattern matches only the new one.', 'ins: The package name carries a build stamp, so the pattern matches only the new one.']);
  });

  it('a ticked task counts as a changed item', () => {
    expect(summary(d('- [ ] run the tests\n', '- [x] run the tests\n').root)).toEqual(['item:changed:run the tests']);
  });

  it('a changed code block merges its lines (R10)', () => {
    expect(summary(d('```ts\nconst port = 8080;\n```\n', '```ts\nconst port = 9090;\n```\n').root)).toEqual(['changed:code', 'lines:-+']);
    expect((d('```ts\nconst port = 8080;\n```\n', '```ts\nconst port = 9090;\n```\n').root.children[0] as DiffBlockNode).children[0]!.data).toMatchObject({ gbWords: '13-17;13-17' });
  });

  it('a changed diagram shows old and new side by side (R11)', () => {
    expect(summary(d('```mermaid\ngraph TD\n  A-->B\n```\n', '```mermaid\ngraph TD\n  A-->C\n```\n').root)).toEqual(['pair', 'removed:code', 'added:code']);
  });

  it('a changed table row diffs its cells; the header stays first (R12)', () => {
    const r = d('| Step | Time |\n|---|---|\n| build | 3 ms |\n', '| Step | Time |\n|---|---|\n| build | 5 ms |\n| test | 1 ms |\n');
    expect(summary(r.root)).toEqual(['row:changed', 'del:3', 'ins:5', 'row:added']);
    expect(plainText((r.root.children[0] as Table).children[0]!)).toBe('Step\nTime');
  });

  it('diffs inside a blockquote', () => {
    expect(summary(d('> One.\n>\n> Two cats.\n', '> One.\n>\n> Two dogs.\n').root)).toEqual(['changed:paragraph', 'del:cats', 'ins:dogs']);
  });

  it('a whitespace-only change marks nothing (R5)', () => {
    const r = d('Some  text\nwrapped here.\n', 'Some text wrapped\nhere.\n');
    expect(summary(r.root)).toEqual([]);
    expect(r.changes).toBe(0);
  });

  it('an added file is all added; a deleted one all removed (R6)', () => {
    expect(summary(d('', '# A\n\nB.\n').root)).toEqual(['added:heading', 'added:paragraph']);
    expect(summary(d('# A\n\nB.\n', '').root)).toEqual(['removed:heading', 'removed:paragraph']);
  });

  it('keeps a <details> block whole: removed and added together (R13)', () => {
    const r = d('<details>\n<summary>More</summary>\n\nOld text.\n\n</details>\n', '<details>\n<summary>More</summary>\n\nNew text.\n\n</details>\n');
    expect(summary(r.root)).toEqual(['removed:html,paragraph,html', 'added:html,paragraph,html']);
  });

  it('a removed heading gives up its anchor to the new document', () => {
    const r = d('## Old part\n\nText.\n', 'Text.\n');
    const h = (r.root.children[0] as DiffBlockNode).children[0] as Heading;
    expect(h.type).toBe('heading');
    expect(h.data?.hProperties?.id).toBeUndefined();
  });

  it("keeps the old side's definitions a removed block refers to", () => {
    const r = d('See [the docs][d].\n\n[d]: https://docs.example/old\n', 'Nothing here.\n');
    expect(r.root.children.filter((n): n is Definition => n.type === 'definition').map((n) => n.url)).toEqual(['https://docs.example/old']);
  });

  it('gives every top-level node a position, so splitChunks sizes its chunks', () => {
    const big = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'x'.repeat(500)}`).join('\n\n');
    const r = d(big, big.replace('Paragraph 7 ', 'Paragraph seven '));
    expect(r.root.children.every((n) => n.position?.end.offset !== undefined)).toBe(true);
    expect(splitChunks(r.root, 4_000).length).toBeGreaterThan(3);
  });

  it('never changes the parsed trees (they are shared through the parse cache)', () => {
    clearParseCache();
    const a = parseMarkdown('# T\n\n1. a\n2. b\n\n```ts\nx\n```\n\n## Gone\n', 'github');
    const b = parseMarkdown('# T2\n\n1. a\n2. c\n\n```ts\ny\n```\n', 'github');
    const before = JSON.stringify([a, b]);
    diffTrees(a, b);
    expect(JSON.stringify([a, b])).toBe(before);
  });

  describe('each change counts once, on its innermost marked node', () => {
    it('a word change in a one-paragraph list item marks the item, its paragraph inline', () => {
      const r = d('- install the tool\n- configure\n', '- install the app\n- configure\n');
      expect(summary(r.root)).toEqual(['item:changed:install the toolapp', 'del:tool', 'ins:app']);
      expect((r.root.children[0] as List).children[0]!.children.map((k) => k.type)).toEqual(['paragraph']);
      expect(r.root.data?.gbChanges).toBe(1);
    });

    it('a changed task item keeps its checkbox and counts once', () => {
      const r = d('- [ ] Write docs\n- [x] Ship\n', '- [ ] Write the docs\n- [x] Ship\n');
      expect(summary(r.root)).toEqual(['item:changed:Write the docs', 'ins:the ']);
      expect((r.root.children[0] as List).children[0]!.checked).toBe(false);
      expect(r.root.data?.gbChanges).toBe(1);
    });

    it('a word change inside a blockquote', () => {
      const r = d('> Two cats.\n', '> Two dogs.\n');
      expect(summary(r.root)).toEqual(['changed:paragraph', 'del:cats', 'ins:dogs']);
      expect(r.root.data?.gbChanges).toBe(1);
    });

    it('an added list item', () => {
      expect(d('- install\n- configure\n', '- install\n- configure\n- verify\n').root.data?.gbChanges).toBe(1);
    });

    it('a removed blockquote of two paragraphs is one change', () => {
      const r = d('Keep.\n\n> One.\n>\n> Two.\n', 'Keep.\n');
      expect(summary(r.root)).toEqual(['removed:blockquote']);
      expect(r.root.data?.gbChanges).toBe(1);
    });

    it('a word change in a nested list marks only the inner item', () => {
      const r = d('- outer\n  - inner old word\n', '- outer\n  - inner new word\n');
      expect(summary(r.root)).toEqual(['item:changed:inner oldnew word', 'del:old', 'ins:new']);
      expect(r.root.data?.gbChanges).toBe(1);
    });

    it('a ticked task is one change, on the item', () => {
      expect(d('- [ ] run the tests\n', '- [x] run the tests\n').root.data?.gbChanges).toBe(1);
    });
  });

  describe('definitions and changes nothing inside shows', () => {
    const notes = (r: ReturnType<typeof d>) => r.root.children.filter((n) => n.type === 'footnoteDefinition');
    const noteOf = (r: ReturnType<typeof d>) => (r.root.children.find((n) => n.type === 'diffBlock') as DiffBlockNode | undefined)?.note;

    it("a footnote's changed text is one change, word-diffed inside it", () => {
      const r = d('Text.[^1]\n\n[^1]: The old note.\n', 'Text.[^1]\n\n[^1]: The new note.\n');
      expect(summary(r.root)).toEqual(['changed:paragraph', 'del:old', 'ins:new']);
      expect(notes(r)).toHaveLength(1);
      expect(r.changes).toBe(1);
    });

    it('an added footnote is marked added; a removed one removed, with its reference', () => {
      const added = d('Text.\n', 'Text.[^n]\n\n[^n]: A note.\n');
      expect(summary(added.root)).toEqual(['changed:paragraph', 'ins:', 'added:paragraph']);
      expect(added.changes).toBe(2);
      const removed = d('Gone.[^n]\n\n[^n]: A note.\n', 'Other text.\n');
      // Two short paragraphs, the only pair: one changed paragraph, its reference removed.
      expect(summary(removed.root)).toEqual(['changed:paragraph', 'del:Gone', 'ins:Other text', 'del:', 'removed:paragraph']);
      expect(notes(removed)).toHaveLength(1);
    });

    it("a footnote nothing references isn't marked or counted (it doesn't render)", () => {
      const r = d('Text.\n\n[^n]: Old.\n', 'Text.\n\n[^n]: New.\n');
      expect(summary(r.root)).toEqual([]);
      expect(r.changes).toBe(0);
    });

    it("a link definition's changed URL marks its uses: the old link removed, the new one added", () => {
      const r = d('See [the docs][d] and [more][d].\n\n- [item][d]\n\n[d]: https://docs.example/old\n', 'See [the docs][d] and [more][d].\n\n- [item][d]\n\n[d]: https://docs.example/new\n');
      expect(summary(r.root)).toEqual(['changed:paragraph', 'del:the docs', 'ins:the docs', 'del:more', 'ins:more', 'item:changed:itemitem', 'del:item', 'ins:item']);
      expect(r.changes).toBe(2);
      const dels: string[] = [];
      visit(r.root, 'diffDel', (n) => { for (const k of n.children) if (k.type === 'link') dels.push(k.url); });
      expect(dels).toEqual(['https://docs.example/old', 'https://docs.example/old', 'https://docs.example/old']);
      expect(r.root.children.filter((n): n is Definition => n.type === 'definition').map((n) => n.url)).toEqual(['https://docs.example/new']);
    });

    it("an ordered list's start number: one change, marked with a note", () => {
      const r = d('3. alpha\n4. beta\n', '5. alpha\n6. beta\n');
      expect(summary(r.root)).toEqual(['changed:list']);
      expect(noteOf(r)).toBe('Start number changed');
      expect(r.changes).toBe(1);
    });

    it("a table's alignment: one change, marked with a note", () => {
      const r = d('| a | b |\n|---|---|\n| 1 | 2 |\n', '| a | b |\n|:--|--:|\n| 1 | 2 |\n');
      expect(summary(r.root)).toEqual(['changed:table']);
      expect(noteOf(r)).toBe('Alignment changed');
      expect(r.changes).toBe(1);
    });

    it("a code block's info string: one change, marked with a note", () => {
      const r = d('```ts title=a.ts\nx\n```\n', '```ts title=b.ts\nx\n```\n');
      expect(summary(r.root)).toEqual(['changed:code', 'lines: ']);
      expect(noteOf(r)).toBe('Code block info changed: title=a.ts → title=b.ts');
      expect(r.changes).toBe(1);
    });
  });

  describe('CRLF line endings', () => {
    const doc = '# Guide\n\nRun the tool once.\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n<div>\n<p>Raw</p>\n</div>\n\n- one\n- two\n';
    const crlf = (s: string) => s.replace(/\n/g, '\r\n');

    it('an LF to CRLF change marks nothing', () => {
      const r = d(doc, crlf(doc));
      expect(summary(r.root)).toEqual([]);
      expect(r.changes).toBe(0);
    });

    it('a CRLF document with one word changed shows exactly that change', () => {
      const r = d(crlf(doc), crlf(doc.replace('once', 'twice')));
      expect(summary(r.root)).toEqual(['changed:paragraph', 'del:once', 'ins:twice']);
      expect(r.changes).toBe(1);
    });

    it('a CRLF code block with one line changed merges only that line', () => {
      const r = d(crlf(doc), crlf(doc.replace('const b = 2;', 'const b = 3;')));
      expect(summary(r.root)).toEqual(['changed:code', 'lines: -+']);
      const code = (r.root.children.find((n) => n.type === 'diffBlock') as DiffBlockNode).children[0] as { value: string };
      expect(code.value).not.toContain('\r');
    });
  });

  describe('one deadline for the whole diff (R14)', () => {
    afterEach(() => vi.restoreAllMocks());
    /** A clock that moves 1 ms on every read, so time spent is the number of reads. */
    const ticking = () => { let t = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => t++); };

    it('the budget is shared by every nested alignment, not restarted for each', () => {
      // 40 changed lists: each list's own alignment is quick, but together they read the clock far
      // more than 200 times.
      const doc = (w: string) => Array.from({ length: 40 }, (_, i) => `Para ${i}.\n\n- item ${w} ${i}\n- more ${i}\n- last ${i}`).join('\n\n');
      clearParseCache();
      const a = parseMarkdown(doc('one'), 'github');
      const b = parseMarkdown(doc('two'), 'github');
      ticking();
      expect(diffTrees(a, b, { timeout: 200 }).gaveUp).toBe(true);
      vi.restoreAllMocks();
      expect(diffTrees(a, b, { timeout: 200 }).gaveUp).toBe(false);
    });

    it('a pathological gap (many similar paragraphs reordered) gives up', () => {
      const paras = Array.from({ length: 300 }, (_, i) => `The service restarts the worker ${i} after the queue drains and the lease ends.`);
      clearParseCache();
      const a = parseMarkdown(paras.join('\n\n'), 'github');
      const b = parseMarkdown([...paras].reverse().join('\n\n'), 'github');
      ticking();
      expect(diffTrees(a, b, { timeout: 500 }).gaveUp).toBe(true);
    });

    it('a word diff past the deadline gives up', () => {
      clearParseCache();
      const a = parseMarkdown('Run the tool once.\n', 'github');
      const b = parseMarkdown('Run the tool twice.\n', 'github');
      ticking();
      expect(diffTrees(a, b, { timeout: 3 }).gaveUp).toBe(true);
    });

    it('a changed fence over WORD_DIFF_MAX_CHARS is removed and added, not line-diffed', () => {
      const body = Array.from({ length: 10_000 }, (_, i) => `line ${i} ${'x'.repeat(12)}`).join('\n');
      const fence = (b: string) => '```txt\n' + b + '\n```\n';
      clearParseCache();
      // A deadline no loaded machine reaches: the outcome is the size cap's, never the clock's
      // (a line diff would give one changed block with '-' and '+' lines).
      const r = diffTrees(parseMarkdown(fence(body), 'github'), parseMarkdown(fence(body.replace('line 5000 ', 'line five ')), 'github'), { timeout: 600_000 });
      expect(body.length).toBeGreaterThan(200_000);
      expect(r.gaveUp).toBe(false);
      expect(summary(r.root)).toEqual(['removed:code', 'added:code']);
      expect(r.changes).toBe(2);
    });
  });

  describe('front matter: a row per key', () => {
    const FM = (body: string) => `---\n${body}\n---\n\n# Repo tests\n`;
    const BASE = 'name: repo-tests\ndescription: Helps choose and run the unit tests.\nowner: tools';

    it('is the files’ own: a changed value diffs its words within its row', () => {
      const r = d(FM(BASE), FM(BASE.replace('the unit tests', 'the e2e tests')));
      expect(summary(r.root)).toEqual(['row:changed', 'del:unit', 'ins:e2e']);
      expect(r.changes).toBe(1);
      const t = r.root.children[0] as Table;
      expect(t.data?.gbFrontmatter).toBe('yaml');
      expect(t.children.map((row) => plainText(row.children[0]!))).toEqual(['name', 'description', 'owner']);
    });

    it('rows pair by key, however much the value changed', () => {
      expect(summary(d(FM('owner: tools'), FM('owner: platform group')).root)).toEqual(['row:changed', 'del:tools', 'ins:platform group']);
    });

    it('an added or removed key is an added or removed row, where it is (or was)', () => {
      const r = d(FM(BASE), FM('name: repo-tests\nversion: 2\ndescription: Helps choose and run the unit tests.'));
      expect(summary(r.root)).toEqual(['row:added', 'row:removed']);
      expect(r.changes).toBe(2);
      expect((r.root.children[0] as Table).children.map((row) => plainText(row))).toEqual(['name\nrepo-tests', 'version\n2', 'description\nHelps choose and run the unit tests.', 'owner\ntools']);
    });

    it('a renamed key is a removed row and an added one, never a word change', () => {
      const r = d(FM('team: tools'), FM('owner: tools'));
      expect(summary(r.root)).toEqual(['row:removed', 'row:added']);
    });

    it('unchanged front matter marks nothing; front matter added to a file is an added block', () => {
      expect(summary(d(FM(BASE), FM(BASE).replace('Repo tests', 'Repo checks')).root)).toEqual(['changed:heading', 'del:tests', 'ins:checks']);
      expect(summary(d('# Repo tests\n', FM(BASE)).root)).toEqual(['added:table']);
    });

    it('front matter that stops parsing is its code block removed and its table added', () => {
      expect(summary(d(FM(BASE), FM('name: [repo-tests')).root)).toEqual(['removed:table', 'added:code']);
    });
  });

  it('reports a gave-up alignment instead of a tree', () => {
    clearParseCache();
    expect(diffTrees(parseMarkdown('One.', 'github'), parseMarkdown('Two.', 'github'), { timeout: -1 }).gaveUp).toBe(true);
  });
});

describe('source lines (review comments, spec 2026-10-08 §3)', () => {
  /** Each top-level block's kind (a marked block's mark) and its lines on each side. */
  const lines = (root: Root) => root.children.filter((n) => n.type !== 'definition').map((n) => [n.type === 'diffBlock' ? n.mark : n.type, n.data?.gbSrc?.new ?? null, n.data?.gbSrc?.old ?? null]);

  it("same blocks keep both sides' lines, removed ones the old side's, added ones the new side's", () => {
    expect(lines(d('# Title\n\nOld para.\n\nKept para.\n', '# Title\n\nKept para.\n\nA new para here.\n').root)).toEqual([
      ['heading', [1, 1], [1, 1]], ['removed', null, [3, 3]], ['paragraph', [3, 3], [5, 5]], ['added', [5, 5], null],
    ]);
  });

  it('front matter is a block: its table carries the front matter\'s lines, so a thread on a key shows under it', () => {
    const fm = (owner: string) => `---\nname: repo-tests\nowner: ${owner}\n---\n\n# Repo tests\n`;
    expect(lines(d(fm('tools'), fm('tools')).root)).toEqual([['table', [1, 4], [1, 4]], ['heading', [6, 6], [6, 6]]]);
    expect(lines(d(fm('tools'), fm('platform')).root)).toEqual([['table', [1, 4], [1, 4]], ['heading', [6, 6], [6, 6]]]);
  });

  it("a changed block's lines are the new side's, with the old side's beside them", () => {
    expect(lines(d('Run the tool once.\n', 'Intro.\n\nRun the tool twice.\n').root)).toEqual([['added', [1, 1], null], ['changed', [3, 3], [1, 1]]]);
  });

  it("a changed list's items get their own lines: kept ones on both sides, an added one on the new side", () => {
    const r = d('- one\n- two\n', 'Intro.\n\n- one\n- two\n- three\n').root;
    const list = r.children.find((n): n is List => n.type === 'list')!;
    expect([list.data?.gbSrc?.new, list.data?.gbSrc?.old]).toEqual([[3, 5], [1, 2]]);
    expect(list.children.map((i: ListItem) => [plainText(i), i.data?.gbSrc?.new ?? null, i.data?.gbSrc?.old ?? null])).toEqual([['one', [3, 3], [1, 1]], ['two', [4, 4], [2, 2]], ['three', [5, 5], null]]);
  });

  it("an unchanged list's items get lines on both sides, walking both in step", () => {
    const list = d('- a\n- b\n', '# T\n\n- a\n- b\n').root.children.find((n): n is List => n.type === 'list')!;
    expect(list.children.map((i) => [i.data?.gbSrc?.new, i.data?.gbSrc?.old])).toEqual([[[3, 3], [1, 1]], [[4, 4], [2, 2]]]);
  });

  it('every block has its own id, and the parsed trees are left as they were', () => {
    clearParseCache();
    const old = parseMarkdown('- a\n- b\n\nText.\n', 'github', true);
    const neu = parseMarkdown('- a\n- c\n\nText!\n', 'github', true);
    const ids: number[] = [];
    visit(diffTrees(old, neu).root, (n: Nodes) => { if (n.data?.gbSrc) ids.push(n.data.gbSrc.id); });
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tree of [old, neu]) visit(tree, (n: Nodes) => { expect(n.data?.gbSrc).toBeUndefined(); });
  });

  it('a wholly added or removed footnote carries its lines', () => {
    const noteBlock = (r: Root) => {
      const note = r.children.find((n) => n.type === 'footnoteDefinition')!;
      const b = note.children[0] as unknown as DiffBlockNode;
      return [b.mark, b.data?.gbSrc?.new ?? null, b.data?.gbSrc?.old ?? null, b.children[0]!.data?.gbSrc?.new ?? b.children[0]!.data?.gbSrc?.old ?? null];
    };
    expect(noteBlock(d('Text.\n', 'Text.[^n]\n\n[^n]: A note.\n').root)).toEqual(['added', [3, 3], null, [3, 3]]);
    expect(noteBlock(d('Gone.[^n]\n\n[^n]: A note.\n', 'Other text.\n').root)).toEqual(['removed', null, [3, 3], [3, 3]]);
  });

  it('chunks keep the lines (the streamed diff renders them too)', () => {
    const chunks = splitChunks(d('Para one.\n', 'Para one.\n\nPara two.\n').root);
    expect(chunks.flatMap((c) => c.children.map((n) => n.data?.gbSrc?.new ?? null))).toEqual([[1, 1], [3, 3]]);
  });
});
