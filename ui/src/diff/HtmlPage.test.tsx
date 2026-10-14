import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import { useTabViews } from '../app/tabStores';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { resetOpenersForTests } from '../openIn/openers';
import { arm } from '../ui/arm/store';
import { createRepoViewStore, fileViewTarget, RepoViewContext, type DiffTarget } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { MAX_PAGE_ASSET_BYTES, MAX_PAGE_ASSETS } from './htmlAssets';
import { HtmlDiff, HtmlPage } from './HtmlPage';

const openers = vi.hoisted(() => ({ list: [] as OpenerPayload[] }));
const openIn = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../api/client', async (actual) => ({ ...(await actual<typeof import('../api/client')>()), api: { listOpeners: async () => openers.list, openIn } }));

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const C = 'c'.repeat(40);
const P = 'a'.repeat(40);
const spec = { kind: 'commit' as const, id: C, parent: 0 };
const CHOOSER: OpenerPayload = { id: 'chooser', name: 'Other…', kind: 'chooser' };
const CDN_PAGE = '<!doctype html><html><head><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0"></script><link rel="stylesheet" href="https://unpkg.com/water.css@2"></head><body><h1>Report</h1></body></html>';

function setup(load: (key: string) => Promise<DiffContentsPayload> = async () => { throw new Error('none'); }) {
  const store = createRepoViewStore(1, '/r', graph, fakeServices({ contents: new Loader(load, new Lru<string, DiffContentsPayload>(10)) }));
  useTabViews.setState({ views: { t1: { repo: 1, services: store.getState().services, store } } });
  const wrap = (ui: React.ReactNode) => render(<RepoViewContext value={store}>{ui}</RepoViewContext>);
  return { store, wrap };
}
const frames = () => [...document.querySelectorAll('iframe')];

beforeEach(() => {
  openers.list = [];
  openIn.mockClear();
  resetOpenersForTests();
});
afterEach(() => {
  cleanup();
  useTabViews.setState({ views: {} });
});

describe('the sandboxed page', () => {
  it('is an <iframe sandbox> with no permissions: no scripts, no same origin, no forms, popups or top navigation', () => {
    const { wrap } = setup();
    wrap(<HtmlPage text={CDN_PAGE} source={null} target={null} path="report.html" />);
    const frame = screen.getByTitle('report.html');
    expect(frame.localName).toBe('iframe');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('sandbox')).not.toMatch(/allow-scripts|allow-same-origin|allow-forms|allow-popups|allow-top-navigation/);
    expect(frame.hasAttribute('src')).toBe(false);
    // Its content comes through srcdoc: the policy first, the page's scripts gone.
    const srcdoc = frame.getAttribute('srcdoc')!;
    expect(srcdoc).toContain('Content-Security-Policy');
    expect(srcdoc).toContain('<h1>Report</h1>');
    expect(srcdoc).not.toContain('<script');
  });

  it('a link in the page opens a new window, which the sandbox refuses: it never navigates the app', () => {
    const { wrap } = setup();
    wrap(<HtmlPage text={'<a href="https://docs.example.test/">Docs</a><a href="#top">Top</a>'} source={null} target={null} path="links.html" />);
    const doc = new DOMParser().parseFromString(screen.getByTitle('links.html').getAttribute('srcdoc')!, 'text/html');
    expect([...doc.querySelectorAll('a')].map((a) => a.getAttribute('target'))).toEqual(['_blank', '_blank']);
    expect(screen.getByTitle('links.html').getAttribute('sandbox')).not.toContain('allow-popups');
  });

  it("inlines the page's relative images and stylesheets from its commit, after a Loading… line", async () => {
    const asked: string[] = [];
    const { wrap } = setup(async (key) => {
      const { path } = JSON.parse(key) as { path: string };
      asked.push(path);
      const blob = (b: Partial<BlobPayload>): BlobPayload => ({ size: 4, binary: false, encoding: 'UTF-8', eol: 'lf', text: null, base64: null, hash: 'h', ...b });
      const neu = path === 'site/img/logo.png' ? blob({ binary: true, base64: 'iVBORw==' }) : path === 'site/css/site.css' ? blob({ text: 'h1 { color: teal }' }) : null;
      return { old: null, new: neu, tooLarge: false, eolOnly: false, image: false };
    });
    wrap(<HtmlPage text={'<link rel="stylesheet" href="css/site.css"><img src="img/logo.png"><img src="missing.png">'} source={{ tabId: 't1', commit: C, path: 'site/index.html' }} target={null} path="index.html" />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    const frame = await screen.findByTitle('index.html');
    const srcdoc = frame.getAttribute('srcdoc')!;
    expect(srcdoc).toContain('src="data:image/png;base64,iVBORw=="');
    expect(srcdoc).toContain('<style>h1 { color: teal }</style>');
    expect(srcdoc).toContain('src="missing.png"');
    expect(asked.sort()).toEqual(['site/css/site.css', 'site/img/logo.png', 'site/missing.png']);
  });
});

describe('the keyboard stays with the app', () => {
  it('the frame is out of the Tab order; when it takes focus, an armed control disarms and focus goes back to the rendered pane', async () => {
    const { wrap } = setup();
    wrap(<div className="html-rendered" tabIndex={-1} data-testid="pane"><HtmlPage text="<p>Hi</p>" source={null} target={null} path="a.html" /></div>);
    const frame = screen.getByTitle('a.html');
    expect(frame).toHaveAttribute('tabindex', '-1');
    const armed = arm({ arm: 'Click again to discard', tone: 'danger', title: 'Discard', body: '', confirmLabel: 'Discard' }, null);
    act(() => frame.focus());
    expect(document.activeElement).toBe(frame);
    act(() => { window.dispatchEvent(new Event('blur')); });
    await expect(armed).resolves.toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('pane')));
  });

  it('a window blur with focus elsewhere (another app) leaves focus alone', async () => {
    const { wrap } = setup();
    wrap(<div className="html-rendered" tabIndex={-1} data-testid="pane"><HtmlPage text="<p>Hi</p>" source={null} target={null} path="a.html" /><button type="button">Other</button></div>);
    const other = screen.getByRole('button', { name: 'Other' });
    act(() => other.focus());
    act(() => { window.dispatchEvent(new Event('blur')); });
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(other);
  });
});

describe('HtmlPage: the bar for what does not run here', () => {
  it('names the external hosts, and Open in browser opens the file with the system chooser (not remembered as Open in…)', async () => {
    openers.list = [{ id: 'code', name: 'VS Code', kind: 'editor' }, CHOOSER];
    const { wrap } = setup();
    const target = fileViewTarget('report.html', C, spec);
    wrap(<HtmlPage text={CDN_PAGE} source={null} target={target} path="report.html" />);
    const bar = screen.getByRole('note');
    expect(bar).toHaveTextContent("This page uses scripts or files from cdn.jsdelivr.net, unpkg.com — they don't run here. Open in browser to see it fully.");
    fireEvent.click(await screen.findByRole('button', { name: 'Open in browser' }));
    expect(openIn).toHaveBeenCalledWith(1, expect.objectContaining({ path: 'report.html', opener: 'chooser', line: null, source: target.new }));
    expect(localStorage.getItem('gitvolt.openIn.v1')).toBeNull();
  });

  it('without a system chooser, the bar has no button', async () => {
    openers.list = [{ id: 'code', name: 'VS Code', kind: 'editor' }];
    const { wrap } = setup();
    wrap(<HtmlPage text={CDN_PAGE} source={null} target={fileViewTarget('report.html', C, spec)} path="report.html" />);
    await act(async () => {});
    expect(screen.getByRole('note')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in browser' })).toBeNull();
  });

  it('a static page has no bar', () => {
    const { wrap } = setup();
    wrap(<HtmlPage text="<h1>Plain</h1><img src='data:image/png;base64,AA'>" source={null} target={null} path="plain.html" />);
    expect(screen.queryByRole('note')).toBeNull();
    expect(frames()).toHaveLength(1);
  });
});

describe('HtmlDiff: old and new pages side by side', () => {
  const target: DiffTarget = { key: 'k', path: 'site/index.html', oldPath: null, status: 'M', old: { kind: 'atCommit', commit: P }, new: { kind: 'atCommit', commit: C }, view: 'diff' };

  it('shows both pages, sandboxed, with one bar for both sides; Open in browser opens the new side', async () => {
    openers.list = [CHOOSER];
    const { wrap } = setup();
    wrap(<HtmlDiff old="<p>Old</p><script>a()</script>" neu={CDN_PAGE} oldSource={null} newSource={null} target={target} path="site/index.html" oldPath={null} />);
    const [old, neu] = frames();
    expect(old.closest('[data-side]')).toHaveAttribute('data-side', 'old');
    expect(neu.closest('[data-side]')).toHaveAttribute('data-side', 'new');
    for (const f of frames()) expect(f.getAttribute('sandbox')).toBe('');
    expect(old.getAttribute('srcdoc')).toContain('<p>Old</p>');
    expect(neu.getAttribute('srcdoc')).toContain('<h1>Report</h1>');
    expect(screen.getAllByRole('note')).toHaveLength(1);
    expect(screen.getByRole('note')).toHaveTextContent('from cdn.jsdelivr.net, unpkg.com');
    fireEvent.click(await screen.findByRole('button', { name: 'Open in browser' }));
    expect(openIn).toHaveBeenCalledWith(1, expect.objectContaining({ path: 'site/index.html', source: target.new }));
  });

  it("a side the change doesn't have says so; a deleted page's Open in browser opens its old side", async () => {
    openers.list = [CHOOSER];
    const { wrap } = setup();
    const deleted: DiffTarget = { ...target, status: 'D', new: { kind: 'absent' } };
    wrap(<HtmlDiff old={CDN_PAGE} neu={null} oldSource={null} newSource={null} target={deleted} path="site/index.html" oldPath={null} />);
    expect(frames()).toHaveLength(1);
    expect(screen.getByText('No new version')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Open in browser' }));
    expect(openIn).toHaveBeenCalledWith(1, expect.objectContaining({ source: deleted.old, fallback: null }));
  });
});

describe('the page loads its files once', () => {
  it('reads no relative file for a page without any', async () => {
    const load = vi.fn(async (): Promise<DiffContentsPayload> => ({ old: null, new: null, tooLarge: false, eolOnly: false, image: false }));
    const { wrap } = setup(load);
    wrap(<HtmlPage text="<p>Hi</p>" source={{ tabId: 't1', commit: C, path: 'a.html' }} target={null} path="a.html" />);
    await waitFor(() => expect(screen.getByTitle('a.html')).toBeInTheDocument());
    expect(load).not.toHaveBeenCalled();
  });

  const image = (base64: string): DiffContentsPayload => ({ old: null, new: { size: base64.length, binary: true, encoding: '', eol: 'lf', text: null, base64, hash: 'h' }, tooLarge: false, eolOnly: false, image: true });

  it('inlines up to the byte budget: the rest are left out, and the bar says so', async () => {
    // Three images of 3 MiB: two fit in 8 MiB, the third doesn't.
    const big = 'A'.repeat(3 * 1024 * 1024);
    const { wrap } = setup(async () => image(big));
    wrap(<HtmlPage text={'<img src="a.png"><img src="b.png"><img src="c.png">'} source={{ tabId: 't1', commit: C, path: 'p.html' }} target={null} path="p.html" />);
    const frame = await screen.findByTitle('p.html');
    const srcs = [...new DOMParser().parseFromString(frame.getAttribute('srcdoc')!, 'text/html').querySelectorAll('img')].map((i) => i.getAttribute('src')!.slice(0, 22));
    expect(srcs).toEqual(['data:image/png;base64,', 'data:image/png;base64,', 'c.png']);
    expect(screen.getByRole('note')).toHaveTextContent("One of this page's images or stylesheets is left out: too large to show here.");
  });

  it(`inlines at most ${MAX_PAGE_ASSETS} files; the bar counts the rest`, async () => {
    const load = vi.fn(async () => image('AAAA'));
    const { wrap } = setup(load);
    const imgs = Array.from({ length: MAX_PAGE_ASSETS + 3 }, (_, i) => `<img src="i${i}.png">`).join('');
    wrap(<HtmlPage text={imgs} source={{ tabId: 't1', commit: C, path: 'p.html' }} target={null} path="p.html" />);
    await screen.findByTitle('p.html');
    expect(load).toHaveBeenCalledTimes(MAX_PAGE_ASSETS);
    expect(screen.getByRole('note')).toHaveTextContent('3 of this page');
    expect(MAX_PAGE_ASSET_BYTES).toBe(8 * 1024 * 1024);
  });
});
