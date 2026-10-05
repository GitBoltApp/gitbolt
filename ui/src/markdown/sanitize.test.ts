import type { Element, Root as HastRoot } from 'hast';
import { visit } from 'unist-util-visit';
import { describe, expect, it } from 'vitest';
import { clearParseCache, parseMarkdown } from './parse';
import { toSafeHast } from './render';

const safe = (md: string): HastRoot => { clearParseCache(); return toSafeHast(parseMarkdown(md, 'github')).hast; };
const elements = (t: HastRoot) => { const out: Element[] = []; visit(t, 'element', (e: Element) => { out.push(e); }); return out; };
const tags = (t: HastRoot) => elements(t).map((e) => e.tagName);
const props = (t: HastRoot) => elements(t).flatMap((e) => Object.keys(e.properties));
const text = (t: HastRoot) => { let s = ''; visit(t, 'text', (n: { value: string }) => { s += n.value; }); return s; };
const hrefs = (t: HastRoot) => elements(t).filter((e) => e.tagName === 'a').map((e) => e.properties.href ?? null);
const srcs = (t: HastRoot) => elements(t).filter((e) => e.tagName === 'img').map((e) => e.properties.src ?? null);

const HOSTILE: Array<[string, string, (t: HastRoot) => void]> = [
  ['a script tag', '<script>alert(1)</script>', (t) => { expect(tags(t)).not.toContain('script'); expect(text(t)).not.toContain('alert'); }],
  ['a javascript: link', '[x](javascript:alert(1))', (t) => expect(hrefs(t)).toEqual([null])],
  ['a vbscript: link', '<a href="vbscript:msgbox(1)">x</a>', (t) => expect(hrefs(t)).toEqual([null])],
  ['entity-encoded schemes', '<a href="jav&#x09;ascript:alert(1)">a</a> <a href="&#106;avascript:alert(1)">b</a> <a href="JaVaScRiPt:alert(1)">c</a>', (t) => expect(hrefs(t)).toEqual([null, null, null])],
  ['an event handler', '<img src="x.png" onerror="alert(1)"><p onclick="alert(1)">p</p>', (t) => expect(props(t).filter((p) => /^on/i.test(p))).toEqual([])],
  ['SVG with onload', '<svg onload="alert(1)"><circle r="9"/><script>alert(2)</script></svg>after', (t) => { expect(tags(t)).not.toContain('svg'); expect(tags(t)).not.toContain('circle'); expect(text(t)).toBe('after'); }],
  ['MathML', '<math><mi>x</mi></math>', (t) => { expect(tags(t)).not.toContain('math'); expect(text(t)).not.toContain('x'); }],
  ['CSS expression and style', '<div style="width:expression(alert(1));background:url(javascript:alert(1))">x</div><style>body{display:none}</style>', (t) => { expect(props(t)).not.toContain('style'); expect(tags(t)).not.toContain('style'); expect(text(t)).toContain('x'); expect(text(t)).not.toContain('display'); }],
  ['a form and its action', '<form action="https://evil.example"><input name="q"><button formaction="https://evil.example">go</button></form>', (t) => { expect(tags(t)).not.toContain('form'); expect(tags(t)).not.toContain('input'); expect(props(t)).not.toContain('formAction'); expect(props(t)).not.toContain('action'); }],
  ['meta refresh and base', '<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><link rel="stylesheet" href="https://evil.example/a.css">', (t) => expect(tags(t).filter((x) => x !== 'p')).toEqual([])],
  ['iframe, object and embed', '<iframe src="https://evil.example"></iframe><object data="x.swf">o</object><embed src="x.swf">', (t) => { expect(tags(t)).toEqual([]); expect(text(t)).not.toContain('o'); }],
  ['nested-HTML breakouts', '<img src="x.png" alt="</textarea><script>alert(1)</script>"><scr<script>ipt>alert(2)</script>\n\n</p><iframe src=//evil.example></iframe>', (t) => { expect(tags(t)).not.toContain('script'); expect(tags(t)).not.toContain('iframe'); }],
  ['data: URLs other than raster images', '<img src="data:image/svg+xml;base64,PHN2Zz4="><img src="data:image/png;base64,iVBORw0KGgo="><a href="data:text/html,<script>alert(1)</script>">d</a>', (t) => { expect(srcs(t)).toEqual([null, 'data:image/png;base64,iVBORw0KGgo=']); expect(hrefs(t)).toEqual([null]); }],
  ['accesskey and tabindex', '<a href="https://x.example" accesskey="g" tabindex="1">x</a>', (t) => { expect(props(t)).not.toContain('accessKey'); expect(props(t)).not.toContain('tabIndex'); }],
  ['form attributes on any element', '<div action="https://evil.example" method="post" enctype="text/plain" accept="*/*" accept-charset="utf-7">x</div>', (t) => expect(props(t)).toEqual([])],
  ['backslash and obfuscated network-path URLs', '<a href="\\\\evil.example">a</a> <a href="/\\evil.example">b</a> <a href="\\/evil.example">c</a> <a href="/\t/evil.example">d</a> <a href="&#92;&#92;evil.example">e</a> <a href="/&#x09;/evil.example">f</a> <a href="&#x2F;&#x0A;&#x2F;evil.example">g</a>', (t) => expect(hrefs(t)).toEqual([null, null, null, null, null, null, null])],
  ['backslash network paths in src and srcset', '<img src="\\\\evil.example/a.png"><img src="/&#x09;/evil.example/a.png"><picture><source srcset="https://x.example/a.png 1x, \\\\evil.example/b.png 2x"></picture>', (t) => { expect(srcs(t)).toEqual([null, null]); expect(elements(t).find((e) => e.tagName === 'source')!.properties.srcSet).toBeUndefined(); }],
  ['xlink:href', '<a xlink:href="javascript:alert(1)" href="https://ok.example">x</a><img xlink:href="//evil.example/a.png" src="a.png"><svg><a xlink:href="javascript:alert(2)">y</a></svg>', (t) => { expect(props(t).filter((p) => /xlink/i.test(p))).toEqual([]); expect(hrefs(t)).toEqual(['https://ok.example']); expect(tags(t)).not.toContain('svg'); }],
  ['an input outside a task list', '<input type="text" value="x">\n\n- [x] done', (t) => expect(elements(t).filter((e) => e.tagName === 'input').map((e) => [e.properties.type, e.properties.disabled])).toEqual([['checkbox', true]])],
];

describe('the sanitizer (spec #5 §6)', () => {
  it.each(HOSTILE)('drops %s', (_name, md, check) => check(safe(md)));

  it('keeps the safe subset: details, kbd, sub/sup, br, picture/source with a checked srcset', () => {
    const t = safe('<details><summary>More</summary>Hidden <kbd>Ctrl</kbd> H<sub>2</sub>O x<sup>2</sup><br></details>\n\n<picture><source srcset="https://x.example/dark.png" media="(prefers-color-scheme: dark)"><source srcset="javascript:alert(1)"><img src="https://x.example/a.png" alt="a"></picture>');
    expect(tags(t)).toEqual(expect.arrayContaining(['details', 'summary', 'kbd', 'sub', 'sup', 'br', 'picture', 'source', 'img']));
    const sets = elements(t).filter((e) => e.tagName === 'source').map((e) => e.properties.srcSet ?? null);
    expect(sets.map((s) => (s === null ? null : String(s)))).toEqual(['https://x.example/dark.png', null]);
  });

  it('prefixes ids and names, and drops every class but language-* on code', () => {
    const t = safe('<h1 id="app" class="big">Title</h1>\n\n<a name="top"></a>\n\n```ts\nx\n```\n\n- [ ] task');
    const h1 = elements(t).find((e) => e.tagName === 'h1')!;
    expect(h1.properties.id).toBe('user-content-app');
    expect(h1.properties.className).toBeUndefined();
    expect(elements(t).find((e) => e.tagName === 'a')!.properties.name).toBe('user-content-top');
    expect(elements(t).find((e) => e.tagName === 'code')!.properties.className).toEqual(['language-ts']);
    expect(elements(t).filter((e) => e.tagName === 'li' || e.tagName === 'ul').map((e) => e.properties.className)).toEqual([undefined, undefined]);
  });

  it('gives headings GitHub’s slugs and footnotes ids their #links reach', () => {
    const t = safe('## What / why\n\n## What / why\n\nNote[^1].\n\n[^1]: The note.');
    expect(elements(t).filter((e) => e.tagName === 'h2' && e.properties.id).map((e) => e.properties.id)).toEqual(['user-content-what--why', 'user-content-what--why-1', 'user-content-footnote-label']);
    const ref = elements(t).find((e) => e.tagName === 'a' && e.properties.dataFootnoteRef !== undefined)!;
    expect([ref.properties.href, ref.properties.id]).toEqual(['#fn-1', 'user-content-fnref-1']);
    expect(elements(t).find((e) => e.tagName === 'li')!.properties.id).toBe('user-content-fn-1');
  });

  it('keeps plain protocol-relative URLs, which the link and image resolvers take as https', () => {
    const t = safe('<a href="//x.example/a">a</a> <a href="&#x2F;&#x2F;x.example/b">b</a> <img src=" //x.example/c.png">');
    expect(hrefs(t)).toEqual(['//x.example/a', '//x.example/b']);
    expect(srcs(t)).toEqual([' //x.example/c.png']);
  });

  it('never gives a raw-HTML heading a Markdown heading’s id', () => {
    const t = safe('<h2>Setup</h2>\n\n## Setup\n\n## Install\n\n<h2>Install</h2>\n\n<h3>Install</h3>');
    expect(elements(t).filter((e) => /^h\d$/.test(e.tagName)).map((e) => e.properties.id)).toEqual(['user-content-setup-1', 'user-content-setup', 'user-content-install', 'user-content-install-1', 'user-content-install-2']);
  });
});

