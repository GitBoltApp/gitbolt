import { describe, expect, it } from 'vitest';
import { clearParseCache, parseMarkdown } from '../parse';
import { alignUnits, blockKey, containment, flowUnits, PAIR_SIMILARITY, similarity } from './blocks';

const units = (md: string) => { clearParseCache(); return flowUnits(parseMarkdown(md, 'github').children); };
const ops = (a: string, b: string) => alignUnits(units(a), units(b))!.map((o) => o.op);

describe('flowUnits and blockKey (5C)', () => {
  it('makes one unit per block, skipping link and footnote definitions', () => {
    expect(units('# Title\n\nText [a] and a note[^1].\n\n[a]: https://docs.example\n\n[^1]: The note.\n').map((u) => u.kind)).toEqual(['heading', 'paragraph']);
  });

  it('keeps an HTML block and the blocks it holds open as one unit', () => {
    const u = units('<details>\n<summary>More</summary>\n\n**Hidden** text.\n\n</details>\n\nAfter.\n');
    expect(u.map((x) => [x.kind, x.nodes.length])).toEqual([['html', 3], ['paragraph', 1]]);
  });

  it('names code by language, diagrams, lists by kind and tables by column count', () => {
    expect(units('```ts\na\n```\n\n```mermaid\ngraph TD\n```\n\n- a\n\n1. b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n').map((u) => u.kind))
      .toEqual(['code:ts', 'mermaid', 'ul', 'ol', 'table:2']);
  });

  it('ignores whitespace that does not render, and list tightness, but not whitespace in code', () => {
    expect(blockKey(units('Some  text\nwrapped here.')[0]!.nodes)).toBe(blockKey(units('Some text wrapped\nhere.')[0]!.nodes));
    expect(blockKey(units('- a\n- b\n')[0]!.nodes)).toBe(blockKey(units('- a\n\n- b\n')[0]!.nodes));
    expect(blockKey(units('```\n  a\n```')[0]!.nodes)).not.toBe(blockKey(units('```\n    a\n```')[0]!.nodes));
    expect(blockKey(units('```\na   \n```')[0]!.nodes)).toBe(blockKey(units('```\na\n```')[0]!.nodes));
  });
});

describe('alignUnits (5C: LCS on normalized block text)', () => {
  it('lines up unchanged blocks and marks added and removed ones', () => {
    expect(ops('# A\n\nOne.\n\nTwo.\n', '# A\n\nOne.\n\nNew here.\n\nTwo.\n')).toEqual(['same', 'same', 'added', 'same']);
    expect(ops('# A\n\nOne.\n\nTwo.\n', '# A\n\nTwo.\n')).toEqual(['same', 'removed', 'same']);
  });

  it('pairs a reworded paragraph or heading as one changed block', () => {
    expect(ops('Run the tool once to warm the cache.', 'Run the tool twice to warm the cache.')).toEqual(['changed']);
    expect(ops('# Setup guide', '## Install guide')).toEqual(['changed']);
  });

  it('pairs a block that grew a lot, or shrank a lot: the shorter one is mostly in the longer (containment)', () => {
    const short = 'Run the installer, then launch the app from the menu.';
    const long = 'Run the installer for your system, then launch the app from the menu. The package name carries a build stamp, and the packaging step deletes older packages first, so the pattern matches only the new one.';
    expect(similarity(short, long)).toBeLessThan(PAIR_SIMILARITY);
    expect(ops(short, long)).toEqual(['changed']);
    expect(ops(long, short)).toEqual(['changed']);
  });

  it('a short block pairs by containment only past a minimum length', () => {
    expect(ops('Build it.', 'Build it and publish the site to the staging host, then tell the team in the channel.')).toEqual(['removed', 'added']);
    expect(ops('Alpha beta gamma.', 'Delta epsilon zeta eta theta iota kappa.')).toEqual(['removed', 'added']);
  });

  describe('an edited heading or short block pairs with one of its kind and level', () => {
    it('a heading that lost words: one changed heading', () => {
      expect(ops('## Windows (in progress)\n\nText.', '## Windows\n\nText.')).toEqual(['changed', 'same']);
    });

    it('a renamed one-word heading, the only pair in its run', () => {
      expect(ops('## Setup\n\nText.', '## Install\n\nText.')).toEqual(['changed', 'same']);
    });

    it('two adjacent edited headings pair one to one', () => {
      expect(ops('## Windows (in progress)\n\n## Linux (beta)\n\nText.', '## Windows\n\n## Linux\n\nText.')).toEqual(['changed', 'changed', 'same']);
    });

    it('in a longer run, short blocks pair by a shared word or a prefix', () => {
      expect(ops('## Windows (in progress)\n\nOld words here entirely.\n\nText.', '## Windows\n\nNew prose, nothing alike.\n\nText.'))
        .toEqual(['changed', 'removed', 'added', 'same']);
      expect(ops('## Install\n\n## Beta\n\nText.', '## Installing\n\n## Gamma\n\nText.')).toEqual(['changed', 'removed', 'added', 'same']);
    });

    it('a short paragraph, the only pair in its run; a longer heading too', () => {
      expect(ops('Coming soon.', 'Done.')).toEqual(['changed']);
      expect(ops('## Installing from a release package\n\nText.', '## Contributing to this project\n\nText.')).toEqual(['changed', 'same']);
    });

    it('a long heading pairs by the lower bar only if one side is short', () => {
      expect(ops('## Windows support (in progress)\n\nOld prose here.\n\nText.', '## Windows\n\nNew words entirely.\n\nText.')).toEqual(['changed', 'removed', 'added', 'same']);
      expect(ops('## Notes on the build steps\n\nOld prose here.\n\nText.', '## Rules for the release flow\n\nNew words entirely.\n\nText.')).toEqual(['removed', 'removed', 'added', 'added', 'same']);
    });

    it('never pairs different kinds or heading levels by these rules', () => {
      expect(ops('## Windows (in progress)\n\nText.', 'Windows\n\nText.')).toEqual(['removed', 'added', 'same']);
      expect(ops('## Setup\n\nText.', '### Install\n\nText.')).toEqual(['removed', 'added', 'same']);
      expect(ops('## Windows (in progress)\n\nText.', '### Windows\n\nText.')).toEqual(['removed', 'added', 'same']);
    });
  });

  it('does not pair unrelated paragraphs', () => {
    expect(ops('Alpha beta gamma delta.', 'Completely different words here.')).toEqual(['removed', 'added']);
  });

  it('shows a moved block as removed where it was and added where it is (R4)', () => {
    expect(ops('First one.\n\nSecond one.\n\nThird one.', 'Second one.\n\nThird one.\n\nFirst one.')).toEqual(['removed', 'same', 'same', 'added']);
  });

  it('pairs lists, tables of the same width, code of the same language and diagrams', () => {
    expect(ops('- a\n- b', '- a\n- b\n- c')).toEqual(['changed']);
    expect(ops('| x |\n|---|\n| 1 |', '| x |\n|---|\n| 2 |')).toEqual(['changed']);
    expect(ops('| x |\n|---|\n| 1 |', '| x | y |\n|---|---|\n| 1 | 2 |')).toEqual(['removed', 'added']);
    expect(ops('```ts\na\n```', '```ts\nb\n```')).toEqual(['changed']);
    expect(ops('```ts\na\n```', '```py\na\n```')).toEqual(['removed', 'added']);
    expect(ops('```mermaid\ngraph TD\n  A-->B\n```', '```mermaid\ngraph TD\n  A-->C\n```')).toEqual(['changed']);
  });

  it('never pairs HTML blocks (R13)', () => {
    expect(ops('<div>a</div>', '<div>b</div>')).toEqual(['removed', 'added']);
  });

  it('an added file is all added, a deleted one all removed (R6)', () => {
    expect(ops('', '# A\n\nB.')).toEqual(['added', 'added']);
    expect(ops('# A\n\nB.', '')).toEqual(['removed', 'removed']);
  });

  it('gives up past its time budget', () => {
    expect(alignUnits(units('One.'), units('Two.'), Date.now() - 1)).toBeNull();
  });
});

describe('containment', () => {
  it("is the common share of the shorter text, and 0 when the shorter one is too short to tell", () => {
    expect(containment('one two three four five', 'one two three four five six seven eight nine ten')).toBe(1);
    expect(containment('one two three four five six seven eight nine ten', 'one two three four five')).toBe(1);
    expect(containment('a b', 'a b c d e f g h')).toBe(0);
    expect(containment('alpha beta gamma delta', 'epsilon zeta eta theta iota')).toBeLessThan(0.3);
  });
});

describe('similarity', () => {
  it('is the common share of the longer text, and 0 past the word-diff cap', () => {
    expect(similarity('a b c d', 'a b c d')).toBe(1);
    expect(similarity('', '')).toBe(1);
    expect(similarity('Run the tool once.', 'Run the tool twice.')).toBeGreaterThanOrEqual(PAIR_SIMILARITY);
    expect(similarity('x'.repeat(20_000), 'x'.repeat(20_000))).toBe(0);
  });
});
