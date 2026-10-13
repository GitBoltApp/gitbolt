import { describe, expect, it, vi } from 'vitest';
import { externalHost, pageNote, pageAssets, pageExternals, pageSrcdoc, PAGE_CSP, readPage, styleText } from './pageDoc';

const parsed = (srcdoc: string) => new DOMParser().parseFromString(srcdoc, 'text/html');

describe('pageExternals: what a page uses that does not show here', () => {
  it('finds http(s) scripts, stylesheets, images, srcsets and CSS imports, each host once, in order', () => {
    const ext = pageExternals(`<!doctype html><html><head>
      <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
      <link rel="stylesheet" href="https://unpkg.com/water.css@2/out/water.css">
      <link rel="preconnect" href="https://preconnect.example.test">
      <style>@import url("https://fonts.example.test/css2?family=Inter"); body { background: url(https://img.example.test/bg.png) }</style>
      </head><body>
      <img src="http://images.example.test/a.png">
      <img src="logo.png" srcset="logo@2x.png 2x, //srcset.example.test/logo@3x.png 3x">
      <picture><source srcset="https://picture.example.test/p.webp"></picture>
      <div style="background-image: url('https://inline.example.test/x.png')"></div>
      <img src="https://cdn.jsdelivr.net/again.png">
      </body></html>`);
    expect(ext.hosts).toEqual([
      'cdn.jsdelivr.net', 'unpkg.com', 'fonts.example.test', 'img.example.test', 'images.example.test',
      'srcset.example.test', 'picture.example.test', 'inline.example.test',
    ]);
    expect(ext.scripts).toBe(true);
  });

  it('finds a quoted @import without url()', () => {
    expect(pageExternals('<style>@import "https://css.example.test/base.css";</style>').hosts).toEqual(['css.example.test']);
  });

  it('a static page with relative and data: files uses nothing external', () => {
    expect(pageExternals('<link rel="stylesheet" href="style.css"><img src="img/a.png"><img src="data:image/png;base64,AAAA"><a href="https://docs.example.test/">docs</a>'))
      .toEqual({ hosts: [], scripts: false });
  });

  it('counts inline scripts, handlers and javascript: links as scripts, but not data scripts', () => {
    expect(pageExternals('<script>console.log(1)</script>').scripts).toBe(true);
    expect(pageExternals('<button onclick="go()">Go</button>').scripts).toBe(true);
    expect(pageExternals('<a href="javascript:go()">Go</a>').scripts).toBe(true);
    expect(pageExternals('<script type="application/ld+json">{"a":1}</script><script type="application/json">{}</script>').scripts).toBe(false);
  });

  it('only script types a browser runs count as scripts', () => {
    for (const type of ['', 'module', 'text/javascript', 'TEXT/JavaScript', 'application/javascript', 'application/x-javascript', 'text/ecmascript', 'text/javascript1.5', 'text/jscript', 'text/javascript; charset=utf-8']) {
      expect(pageExternals(`<script type="${type}">a()</script>`).scripts, type).toBe(true);
    }
    for (const type of ['text/babel', 'text/x-handlebars-template', 'importmap', 'application/ld+json', 'text/markdown', 'speculationrules']) {
      expect(pageExternals(`<script type="${type}">a()</script>`).scripts, type).toBe(false);
    }
    expect(pageExternals('<script type="text/babel" src="https://cdn.example.test/app.jsx"></script>').hosts).toEqual([]);
  });

  it('only event handler attributes count as handlers', () => {
    expect(pageExternals('<body onload="x()">').scripts).toBe(true);
    expect(pageExternals('<img src="a.png" onerror="x()">').scripts).toBe(true);
    expect(pageExternals('<svg><rect onmouseover="x()"/></svg>').scripts).toBe(true);
    expect(pageExternals('<div one="1" only="2" on="3" onward="4"></div>').scripts).toBe(false);
  });

  it("SVG's <image> and <use> files on other hosts are external", () => {
    expect(pageExternals('<svg><image href="https://img.example.test/a.png"/><use xlink:href="https://sprites.example.test/s.svg#i"/><use href="#local"/></svg>').hosts)
      .toEqual(['img.example.test', 'sprites.example.test']);
  });

  it('a data script with an http src is not an external script', () => {
    expect(pageExternals('<script type="application/json" src="https://data.example.test/a.json"></script>').hosts).toEqual([]);
  });

  it('externalHost: http(s) and protocol-relative URLs only', () => {
    expect(externalHost('https://unpkg.com/x.js')).toBe('unpkg.com');
    expect(externalHost('//cdn.example.test/x.js')).toBe('cdn.example.test');
    expect(externalHost('HTTP://Upper.Example.Test/x')).toBe('upper.example.test');
    expect(externalHost('x.js')).toBeNull();
    expect(externalHost('data:text/css,a')).toBeNull();
    expect(externalHost('/root.css')).toBeNull();
  });
});

describe('pageNote: the bar above the render', () => {
  it('names the hosts, and says the page shows fully in a browser', () => {
    expect(pageNote({ hosts: ['cdn.jsdelivr.net', 'unpkg.com'], scripts: true }))
      .toBe("This page uses scripts or files from cdn.jsdelivr.net, unpkg.com — they don't run here. Open in browser to see it fully.");
  });

  it('only inline scripts: says so without hosts', () => {
    expect(pageNote({ hosts: [], scripts: true })).toBe("This page uses scripts — they don't run here. Open in browser to see it fully.");
  });

  it('nothing external: no bar', () => {
    expect(pageNote({ hosts: [], scripts: false })).toBeNull();
  });

  it('many hosts: the first three and how many more', () => {
    expect(pageNote({ hosts: ['a.test', 'b.test', 'c.test', 'd.test', 'e.test'], scripts: false }))
      .toContain('from a.test, b.test, c.test and 2 more —');
    expect(pageNote({ hosts: ['a.test', 'b.test', 'c.test', 'd.test'], scripts: false })).toContain('from a.test, b.test, c.test, d.test —');
  });

  it('says how many of its own files were left out, alone or after the hosts', () => {
    expect(pageNote({ hosts: [], scripts: false }, 1)).toBe("One of this page's images or stylesheets is left out: too large to show here. Open in browser to see it fully.");
    expect(pageNote({ hosts: ['unpkg.com'], scripts: false }, 3))
      .toBe("This page uses scripts or files from unpkg.com — they don't run here. 3 of its images and stylesheets are left out: too large to show here. Open in browser to see it fully.");
  });
});

describe('readPage: one parse for the bar, the inlining and the frame', () => {
  it('parses once; the srcdoc works on a copy, so the page can be shown again', () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const page = readPage('<link rel="stylesheet" href="a.css"><script src="https://cdn.example.test/a.js"></script><img src="b.png">');
    expect(parse).toHaveBeenCalledTimes(1);
    expect(page.externals).toEqual({ hosts: ['cdn.example.test'], scripts: true });
    expect(page.assets).toEqual({ images: ['b.png'], styles: ['a.css'] });
    const first = pageSrcdoc(page, { images: new Map(), styles: new Map([['a.css', 'p { margin: 0 }']]) });
    expect(page.doc.querySelector('script')).not.toBeNull();
    expect(pageSrcdoc(page, { images: new Map(), styles: new Map([['a.css', 'p { margin: 0 }']]) })).toBe(first);
    parse.mockRestore();
  });
});

describe('pageSrcdoc: the page as the sandboxed frame shows it', () => {
  it('puts the tightening policy first in the head, before the page own styles', () => {
    const doc = parsed(pageSrcdoc('<!doctype html><html><head><link rel="stylesheet" href="https://unpkg.com/a.css"><title>T</title></head><body>Hi</body></html>'));
    const first = doc.head.firstElementChild!;
    expect(first.localName).toBe('meta');
    expect(first.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(first.getAttribute('content')).toBe(PAGE_CSP);
    expect(PAGE_CSP).toMatch(/default-src 'none'/);
    expect(PAGE_CSP).not.toMatch(/https?:|'self'|\*/);
  });

  it('keeps the doctype (standards mode), and adds none to a page without one', () => {
    expect(pageSrcdoc('<!DOCTYPE html><p>a</p>')).toMatch(/^<!DOCTYPE html><html>/);
    expect(pageSrcdoc('<p>a</p>')).toMatch(/^<html>/);
  });

  it('takes out scripts, handlers, refreshes, <base> and nested srcdoc', () => {
    const doc = parsed(pageSrcdoc(`<head><base href="https://example.test/"><meta http-equiv="refresh" content="0;url=https://example.test/">
      <script src="https://cdn.example.test/a.js"></script></head><body onload="x()"><script>alert(1)</script>
      <button onclick="go()">Go</button><iframe srcdoc="<a href=x>x</a>"></iframe><noscript><p>No scripts</p></noscript></body>`));
    expect(doc.querySelectorAll('script, base, meta[http-equiv="refresh"]')).toHaveLength(0);
    expect(doc.body.hasAttribute('onload')).toBe(false);
    expect(doc.querySelector('button')!.hasAttribute('onclick')).toBe(false);
    expect(doc.querySelector('iframe')!.hasAttribute('srcdoc')).toBe(false);
    expect(doc.querySelector('noscript')).not.toBeNull();
  });

  it('takes out every <link> not inlined, and ping and attributionsrc', () => {
    const doc = parsed(pageSrcdoc(`<head><link rel="stylesheet" href="https://unpkg.com/a.css"><link rel="prefetch" href="next.html"><link rel="icon" href="fav.png">
      <link rel="dns-prefetch" href="//cdn.example.test"></head><body><a href="https://example.test/" ping="https://track.example.test/">a</a>
      <img src="a.png" attributionsrc="https://ads.example.test/"><svg><link href="x"/></svg></body>`));
    expect(doc.querySelectorAll('link')).toHaveLength(0);
    expect(doc.querySelectorAll('[ping], [attributionsrc]')).toHaveLength(0);
    expect(doc.querySelector('a')!.getAttribute('href')).toBe('https://example.test/');
  });

  it('links never navigate: each opens a new window, which the sandbox refuses (fragments too)', () => {
    const doc = parsed(pageSrcdoc('<a href="https://docs.example.test/" target="_self">ext</a><a href="other.html">rel</a><a href="#top">top</a><a href="javascript:go()">js</a><map><area href="https://example.test/"></map><form action="https://example.test/"></form>'));
    for (const a of doc.querySelectorAll('a, area, form')) expect(a.getAttribute('target')).toBe('_blank');
    expect(doc.querySelector('a[href^="javascript"]')).toBeNull();
    expect(doc.querySelectorAll('a[href]')).toHaveLength(3);
  });

  it('inlines relative images and stylesheets it was given; leaves the rest as they are', () => {
    const doc = parsed(pageSrcdoc(
      '<head><link rel="stylesheet" href="css/site.css" media="screen"><link rel="stylesheet" href="missing.css"></head><body><img src="img/a.png"><img src="img/b.png"></body>',
      { images: new Map([['img/a.png', 'data:image/png;base64,AAAA']]), styles: new Map([['css/site.css', 'body { color: rebeccapurple }']]) },
    ));
    const style = doc.head.querySelector('style')!;
    expect(style.textContent).toBe('body { color: rebeccapurple }');
    expect(style.getAttribute('media')).toBe('screen');
    expect(doc.querySelector('link')).toBeNull();
    expect([...doc.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['data:image/png;base64,AAAA', 'img/b.png']);
  });

  /** No script, no handler, no `javascript:` link anywhere in `srcdoc` as the frame parses it,
   * and parsing and cleaning it again changes nothing (it has settled). */
  const expectInert = (srcdoc: string) => {
    const doc = parsed(srcdoc);
    expect(doc.querySelectorAll('script, base')).toHaveLength(0);
    const handlers = [...doc.querySelectorAll('*')].flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${el.localName}[${a.name}]`));
    expect(handlers).toEqual([]);
    expect(doc.querySelector('[href^="javascript" i]')).toBeNull();
    expect(doc.head.firstElementChild!.getAttribute('content')).toBe(PAGE_CSP);
    expect(pageSrcdoc(srcdoc)).toBe(srcdoc);
  };

  it("a hostile stylesheet can't end its <style> and add markup", () => {
    const hostile = 'body { color: teal } </style><img src=x onerror="alert(1)"><script>alert(2)</script></STYLE ><a href="javascript:alert(3)">x</a>';
    const out = pageSrcdoc('<head><link rel="stylesheet" href="evil.css"></head><body><p>Hi</p></body>', { images: new Map(), styles: new Map([['evil.css', hostile]]) });
    expectInert(out);
    const doc = parsed(out);
    expect(doc.querySelectorAll('style')).toHaveLength(1);
    expect(doc.querySelectorAll('img, a')).toHaveLength(0);
    expect(doc.querySelector('style')!.textContent).toContain('<\\/style><img src=x onerror="alert(1)">');
    expect(doc.body.textContent).toBe('Hi');
  });

  it.each([
    ['SVG <style> after a stray </p>', '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">'],
    ['MathML <mglyph> in a table', '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=alert(1)&gt;">'],
    ['<noscript> holding a closing tag in an attribute', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
    ['a form in a form', '<form id="a"><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>'],
    ['an SVG <a> with xlink:href', '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'],
  ])('markup that reads differently once parsed again is cleaned until it settles: %s', (_name, html) => {
    expectInert(pageSrcdoc(html));
  });

  it("styleText: `</style` (any case) can't end the element; CSS reads it the same", () => {
    expect(styleText('a::after { content: "</style>" } /* </STYLE */')).toBe('a::after { content: "<\\/style>" } /* <\\/STYLE */');
  });
});

describe('pageAssets: the relative files that can be inlined', () => {
  it("a reference named like an object's own key is only a key", () => {
    const doc = parsed(pageSrcdoc('<img src="__proto__"><img src="constructor"><link rel="stylesheet" href="toString">'));
    expect([...doc.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['__proto__', 'constructor']);
    expect(doc.querySelector('style')).toBeNull();
  });

  it('lists relative images and stylesheets once each; not external, data:, fragments or root-less schemes', () => {
    expect(pageAssets(`<link rel="stylesheet" href="a.css"><link rel="icon" href="fav.png"><link rel="stylesheet" href="https://unpkg.com/b.css">
      <img src="x.png"><img src="x.png"><img src="//cdn.example.test/y.png"><img src="data:image/png;base64,AA"><img src="../up/z.svg">`))
      .toEqual({ images: ['x.png', '../up/z.svg'], styles: ['a.css'] });
  });
});
