import { describe, expect, it } from 'vitest';
import { visit } from 'unist-util-visit';
import { clearParseCache, parseMarkdown } from '../parse';
import type { Element } from 'hast';
import { toSafeHast } from '../render';
import { growth } from '../../test-perf';
import type { MdFlavor, MdReferenceNode } from '../types';

const refs = (md: string, flavor: MdFlavor = 'gitlab') => {
  clearParseCache();
  const out: Array<Omit<MdReferenceNode, 'type' | 'position'>> = [];
  visit(parseMarkdown(md, flavor), 'reference', (n: MdReferenceNode) => { out.push({ refKind: n.refKind, project: n.project, number: n.number, sha: n.sha, user: n.user, value: n.value }); });
  return out;
};
const ref = (refKind: MdReferenceNode['refKind'], value: string, over: Partial<MdReferenceNode> = {}) => ({ refKind, project: null, number: null, sha: null, user: null, value, ...over });

describe('the references plugin (spec #5 §3.1)', () => {
  it('finds #n and project#n, and GitLab’s !n and group/project!n in the gitlab flavor only', () => {
    expect(refs('Fixes #12, see group/sub/project#3 and !45 or group/project!7.')).toEqual([
      ref('issue', '#12', { number: 12 }),
      ref('issue', 'group/sub/project#3', { project: 'group/sub/project', number: 3 }),
      ref('mr', '!45', { number: 45 }),
      ref('mr', 'group/project!7', { project: 'group/project', number: 7 }),
    ]);
    expect(refs('Fixes #12 and octo-org/widget#4, not !45 or a/b/c#1', 'github')).toEqual([
      ref('issue', '#12', { number: 12 }),
      ref('issue', 'octo-org/widget#4', { project: 'octo-org/widget', number: 4 }),
    ]);
  });

  it('takes a SHA as a whole word of 7 to 40 hex digits with a letter and a digit, or 40 digits', () => {
    const forty = '1234567890123456789012345678901234567890';
    expect(refs(`abc1234 and ${forty} but not 1234567, deadbeef, abc12345z, 0xabc1234 or #abc1234`)).toEqual([
      ref('commit', 'abc1234', { sha: 'abc1234' }),
      ref('commit', forty, { sha: forty }),
    ]);
  });

  it('finds @user, not an email address', () => {
    expect(refs('Thanks @ada.l and @grace-h, mail ada@example.com')).toEqual([
      ref('mention', '@ada.l', { user: 'ada.l' }),
      ref('mention', '@grace-h', { user: 'grace-h' }),
    ]);
  });

  it('skips code, links and URLs', () => {
    expect(refs('`#1` [#2](https://x.example/#3) https://x.example/a#4 <https://x.example/#5>\n\n```\n#6 abc1234\n```')).toEqual([]);
  });

  it('stays linear on hostile runs (no catastrophic backtracking)', () => {
    // Growth, not a budget (see test-perf.ts): 4x the text costs about 4x the CPU time (3.8-3.9x
    // measured idle, 2.5-3.8x loaded); the quadratic regexes cost 16x, and took minutes at 200 kB.
    for (const flavor of ['github', 'gitlab'] as const) {
      for (const [unit, tail] of [['.', ''], ['-a', ''], ['a/', ''], ['a/', '#1'], ['a.', '!1']]) {
        const g = growth((size) => {
          const text = unit.repeat(size / unit.length) + tail;
          return () => { clearParseCache(); parseMarkdown(text, flavor); };
        }, 5_000);
        expect(g.ratio, `${flavor}: ${unit}…${tail} (${g.small.toFixed(1)} ms, then ${g.large.toFixed(1)} ms)`).toBeLessThan(8);
      }
    }
    clearParseCache();
  }, 60_000);

  it('keeps project paths to GitHub/GitLab’s limits, whole or not at all', () => {
    const long = 'a'.repeat(101);
    expect(refs(`${long}/repo#1 and o/${long}#2`, 'github')).toEqual([]);
    const deep = Array.from({ length: 22 }, (_, i) => `g${i}`).join('/');
    expect(refs(`${deep}#3 and x.y/z#4`)).toEqual([ref('issue', 'x.y/z#4', { project: 'x.y/z', number: 4 })]);
  });

  it('leaves text inside raw-HTML links and code as text', () => {
    const { hast, refs: found } = toSafeHast(parseMarkdown('<a href="https://x.example">#12 <b>@ada</b></a> <code>abc1234 #5</code> x <pre>#6</pre> and #3', 'github'));
    const spans: Element[] = [];
    visit(hast, 'element', (e: Element) => { if (e.properties.dataGbRef !== undefined) spans.push(e); });
    expect(spans.map((e) => found[Number(String(e.properties.dataGbRef).split(':')[1])].value)).toEqual(['#3']);
    let text = '';
    visit(hast, 'text', (n: { value: string }) => { text += n.value; });
    expect(text).toContain('#12 @ada');
    expect(text).toContain('abc1234 #5');
    expect(text).toContain('#6');
  });
});
