import { describe, expect, it } from 'vitest';
import { growth } from '../../test-perf';
import { decodeEntities, parseSystemNote, safeUrl } from './systemNote';

const BASE = 'https://gitlab.example.com/Acme/shop/-/merge_requests/1203';
const parse = (b: string) => parseSystemNote(b, BASE);

describe('system notes as structured parts (never HTML)', () => {
  it('"added 1 commit": a commit list (entity decoded) and the compare link, resolved against the MR host', () => {
    const n = parse('added 1 commit <ul><li>9a4c1e07 - Checkout: build the order from the cart&#39;s lines alone</li></ul> [Compare with previous version](/Acme/shop/-/merge_requests/1203/diffs?diff_id=40917&start_sha=3e9f02d4)');
    expect(n.kind).toBe('commits');
    expect(n.parts).toEqual([
      { t: 'text', text: 'added 1 commit ' },
      { t: 'commits', items: [{ sha: '9a4c1e07', subject: "Checkout: build the order from the cart's lines alone" }], more: 0 },
      { t: 'link', text: 'Compare with previous version', url: 'https://gitlab.example.com/Acme/shop/-/merge_requests/1203/diffs?diff_id=40917&start_sha=3e9f02d4' },
    ]);
  });

  it('"changed this line in version 2 of the diff": an edit, its link kept', () => {
    const n = parse('changed this line in [version 2 of the diff](/Acme/shop/-/merge_requests/1203/diffs?diff_id=40918&start_sha=3e9f02d4#a1b2_10_12)');
    expect(n).toEqual({ kind: 'edit', parts: [
      { t: 'text', text: 'changed this line in ' },
      { t: 'link', text: 'version 2 of the diff', url: 'https://gitlab.example.com/Acme/shop/-/merge_requests/1203/diffs?diff_id=40918&start_sha=3e9f02d4#a1b2_10_12' },
    ] });
  });

  it('a sha…sha range line and the Markdown bullet form', () => {
    const n = parse('added 15 commits\n\n* 7e2b41c9…d03f58aa - 14 commits from branch `dev`\n* b6c3e1f0 - Rebase onto dev\n\n[Compare with previous version](https://gitlab.example.com/x)');
    expect(n.kind).toBe('commits');
    const commits = n.parts.find((p) => p.t === 'commits');
    expect(commits).toEqual({ t: 'commits', items: [{ sha: '7e2b41c9…d03f58aa', subject: '14 commits from branch dev' }, { sha: 'b6c3e1f0', subject: 'Rebase onto dev' }], more: 0 });
  });

  it('"mentioned in merge request !1204"', () => {
    const n = parse('mentioned in merge request !1204');
    expect(n).toEqual({ kind: 'mention', parts: [{ t: 'text', text: 'mentioned in merge request !1204' }] });
  });

  it('mentioned in, with a link', () => {
    const n = parse('mentioned in merge request [!1204](/Acme/shop/-/merge_requests/1204)');
    expect(n.kind).toBe('mention');
    expect(n.parts[1]).toEqual({ t: 'link', text: '!1204', url: 'https://gitlab.example.com/Acme/shop/-/merge_requests/1204' });
  });

  it('a title change in idiff HTML: old struck, new added', () => {
    const n = parse('changed title from <code class="idiff">Draft: Third-party checkout updates</code> to <code class="idiff">Third-party checkout updates</code>');
    expect(n.kind).toBe('title');
    expect(n.parts).toEqual([
      { t: 'text', text: 'changed title from ' },
      { t: 'del', text: 'Draft: Third-party checkout updates' },
      { t: 'text', text: ' to ' },
      { t: 'ins', text: 'Third-party checkout updates' },
    ]);
  });

  it('a title change with idiff spans inside the code', () => {
    const n = parse('changed title from <code class="idiff"><span class="idiff left right deletion">Draft: </span>Fix</code> to <code class="idiff">Fix</code>');
    expect(n.parts.filter((p) => p.t === 'del' || p.t === 'ins')).toEqual([{ t: 'del', text: 'Draft: Fix' }, { t: 'ins', text: 'Fix' }]);
  });

  it('a title change in Markdown diff form', () => {
    const n = parse('changed title from **{-Draft: Fix-}** to **{+Fix+}**');
    expect(n.parts.filter((p) => p.t === 'del' || p.t === 'ins')).toEqual([{ t: 'del', text: 'Draft: Fix' }, { t: 'ins', text: 'Fix' }]);
  });

  it('<code> is a mono span', () => {
    expect(parse('changed target branch to <code>dev</code>').parts).toEqual([{ t: 'text', text: 'changed target branch to ' }, { t: 'code', text: 'dev' }]);
  });

  it('unknown tags are stripped to their text; markup in entities stays text', () => {
    const n = parse('approved <b onclick="x()">this</b> <script>alert(1)</script> &lt;img src=x&gt; &amp; more');
    expect(n.kind).toBe('approved');
    const text = n.parts.map((p) => ('text' in p ? p.text : '')).join('');
    expect(text).toBe('approved this alert(1) <img src=x> & more');
    expect(n.parts.every((p) => p.t === 'text')).toBe(true);
  });

  it('refuses a non-http link (kept as plain text) and resolves a relative one', () => {
    const bad = parse('mentioned in [x](javascript:alert(1)) and [y](data:text/html,hi) and [z](//evil.example/a)');
    expect(bad.parts.some((p) => p.t === 'link')).toBe(false);
    expect(safeUrl('/a/b', BASE)).toBe('https://gitlab.example.com/a/b');
    expect(safeUrl('https://x.example/a', BASE)).toBe('https://x.example/a');
    expect(safeUrl('ftp://x.example/a', BASE)).toBeNull();
    expect(safeUrl('relative/path', BASE)).toBeNull();
  });

  it('refuses relative links that escape the host (backslash, tab, newline, controls)', () => {
    for (const u of ['/\\evil.example/x', '/&#9;/evil.example', '/&#10;/evil.example', '/&#13;/evil.example', '/\u0000/evil.example', '/a b']) expect(safeUrl(u, BASE), u).toBeNull();
    expect(parse('mentioned in [x](/\\evil.example/x)').parts.some((p) => p.t === 'link')).toBe(false);
  });

  it("does not turn a title note's text into links", () => {
    const n = parse('changed title from <code class="idiff">[a](https://evil.example)</code> to <code class="idiff">b</code>');
    expect(n.parts.some((p) => p.t === 'link')).toBe(false);
  });

  // Growth, not a budget (see test-perf.ts), unit by unit.
  const UNITS = ['{-', '[', '<', '{+', '`', '[a](', '<code class="idiff">'];
  const unitCost = (unit: string) => (size: number) => { const body = unit.repeat(Math.ceil(size / unit.length)); return () => { parse(body); }; };

  it('parses adversarial bodies in linear time', () => {
    // Every span is bounded, so 4x the body costs about 4x the CPU time (3.3-4.2x measured idle,
    // 2.1-4.2x loaded); quadratic parsing would cost 16x.
    for (const unit of UNITS) {
      const g = growth(unitCost(unit), 5_000);
      expect(g.ratio, `${unit}: 5 kB ${g.small.toFixed(1)} ms, 20 kB ${g.large.toFixed(1)} ms`).toBeLessThan(8);
    }
  }, 60_000);

  it('caps adversarial 200 kB bodies: no costlier than 20 kB, with bounded output', () => {
    // The body is capped at 20 kB, so 10x past the cap costs about the same (1-2.4x measured,
    // idle or loaded); uncapped, 10x.
    for (const unit of UNITS) {
      const g = growth(unitCost(unit), 20_000, { factor: 10 });
      expect(g.ratio, `${unit}: 20 kB ${g.small.toFixed(1)} ms, 200 kB ${g.large.toFixed(1)} ms`).toBeLessThan(5);
      const body = unit.repeat(Math.ceil(200_000 / unit.length));
      expect(JSON.stringify(parse(body).parts).length, unit).toBeLessThan(100_000);
    }
  }, 60_000);

  it('caps a long commit list at 50 and counts the rest', () => {
    const lis = Array.from({ length: 80 }, (_, i) => `<li>${String(i).padStart(8, 'a')} - c${i}</li>`).join('');
    const c = parse(`added 80 commits <ul>${lis}</ul>`).parts.find((p) => p.t === 'commits');
    expect(c?.t === 'commits' && [c.items.length, c.more]).toEqual([50, 30]);
  });

  it('GitLab Markdown title change: the whole old and new titles, no stray **', () => {
    const n = parse('changed title from **{-Draft: -}Foo &amp; Bar** to **Foo &amp; Bar**');
    expect(n).toEqual({ kind: 'title', parts: [{ t: 'text', text: 'changed title from ' }, { t: 'del', text: 'Draft: Foo & Bar' }, { t: 'text', text: ' to ' }, { t: 'ins', text: 'Foo & Bar' }] });
    const n2 = parse('changed title from **Foo** to **{+Draft: +}Foo**');
    expect(n2.parts[3]).toEqual({ t: 'ins', text: 'Draft: Foo' });
  });

  it('strips ** elsewhere and renders backticks as mono', () => {
    const n = parse('marked this merge request as **draft** and set `dev`');
    expect(n.kind).toBe('draft');
    expect(n.parts).toEqual([{ t: 'text', text: 'marked this merge request as draft and set ' }, { t: 'code', text: 'dev' }]);
  });

  it('classifies GitLab events', () => {
    const k = (b: string) => parse(b).kind;
    expect(k('changed the description')).toBe('edit');
    expect(k('approved this merge request')).toBe('approved');
    expect(k('unapproved this merge request')).toBe('unapproved');
    expect(k('requested changes')).toBe('unapproved');
    expect(k('merged')).toBe('merged');
    expect(k('closed')).toBe('closed');
    expect(k('reopened')).toBe('reopened');
    expect(k('marked this merge request as **draft**')).toBe('draft');
    expect(k('marked this merge request as **ready**')).toBe('draft');
    expect(k('added ~12 label')).toBe('label');
    expect(k('assigned to @bob')).toBe('other');
  });

  it('decodes numeric and named entities, leaving unknown ones', () => {
    expect(decodeEntities('a&#39;b &#x41; &amp;lt; &bogus;')).toBe("a'b A &lt; &bogus;");
  });
});
