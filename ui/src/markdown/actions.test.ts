import { beforeEach, describe, expect, it, vi } from 'vitest';

const SHA = 'abc1234def5678abc1234def5678abc1234def56';
const api = vi.hoisted(() => ({ openUrl: vi.fn(async () => null) }));
vi.mock('../api/client', () => ({ api, errorMessage: String }));
const poll = vi.hoisted(() => ({ openMrView: vi.fn(), loadMrDetail: vi.fn(async () => {}), refreshMr: vi.fn(async () => {}) }));
vi.mock('../forge/poll', () => poll);
const showInGraph = vi.hoisted(() => vi.fn());
vi.mock('../menu/menuEnv', () => ({ fileMenuEnv: () => ({ act: { showInGraph } }) }));
vi.mock('../app/tabStores', async (orig) => ({ ...(await orig<typeof import('../app/tabStores')>()), tabStore: () => ({ getState: () => ({ indexById: new Map([[SHA, 0]]) }) }) }));

const { openLinkTarget, registerFileLinkHandler } = await import('./actions');
const { browserUrlFor, linkTooltip } = await import('./links');
const { patchForge, useForge } = await import('../forge/mrStore');
const { detailOf, mrOf, projectOf } = await import('../forge/testMrs');

const forge = { kind: 'forge', tabId: 't' } as const;
const file = { kind: 'file', tabId: 't', commit: 'c0ffee1', path: 'docs/README.md' } as const;

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', remote: 'origin', project: projectOf() });
});

describe('a plain click (spec #5 §4.1)', () => {
  it('opens a GitLab MR in-app', async () => {
    await openLinkTarget(forge, { kind: 'mr', number: 5, webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/5' });
    expect(poll.openMrView).toHaveBeenCalledWith('t', 5);
  });

  it('a GitHub #n that isn’t a PR opens in the browser', async () => {
    patchForge('t', { kind: 'github', project: projectOf('octo-org/widget', 'github') });
    await openLinkTarget(forge, { kind: 'mr', number: 9, webUrl: 'https://github.com/octo-org/widget/issues/9' });
    expect(poll.loadMrDetail).toHaveBeenCalledWith('t', 9, 0);
    expect(poll.openMrView).not.toHaveBeenCalled();
    expect(api.openUrl).toHaveBeenCalledWith('https://github.com/octo-org/widget/issues/9');
    poll.loadMrDetail.mockImplementationOnce(async () => { patchForge('t', { details: { 4: { value: detailOf(mrOf(4)), at: 1 } } }); });
    await openLinkTarget(forge, { kind: 'mr', number: 4, webUrl: 'https://github.com/octo-org/widget/issues/4' });
    expect(poll.openMrView).toHaveBeenCalledWith('t', 4);
  });

  it('selects a local commit in the graph; opens one that isn’t on the forge', async () => {
    await openLinkTarget(forge, { kind: 'commit', sha: SHA, webUrl: null });
    expect(showInGraph).toHaveBeenCalledWith(SHA);
    await openLinkTarget(forge, { kind: 'commit', sha: 'fed9876', webUrl: 'https://gitlab.example.com/group/project/-/commit/fed9876' });
    expect(api.openUrl).toHaveBeenCalledWith('https://gitlab.example.com/group/project/-/commit/fed9876');
  });

  it('scrolls to an anchor inside its own document, never the window', async () => {
    document.body.innerHTML = '<div class="flyout-body"><h2 id="user-content-install">Other</h2><div class="md"><h2 id="user-content-install">Install</h2><a id="from">x</a></div></div>';
    const pane = document.querySelector('.flyout-body') as HTMLElement;
    const [other, target] = [...document.querySelectorAll('h2')] as HTMLElement[];
    pane.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
    other!.getBoundingClientRect = () => ({ top: 60 }) as DOMRect;
    target!.getBoundingClientRect = () => ({ top: 850 }) as DOMRect;
    target!.scrollIntoView = vi.fn();
    const href = window.location.href;
    await openLinkTarget(forge, { kind: 'anchor', id: 'user-content-install' }, document.getElementById('from')!);
    // The flyout's body scrolls to this document's heading (not another body's); nothing else does.
    expect(pane.scrollTop).toBe(800);
    expect(target!.scrollIntoView).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
  });

  it('gives a file link to 5B’s handler in File View; the browser in a forge context', async () => {
    const handler = vi.fn();
    const off = registerFileLinkHandler(handler);
    await openLinkTarget(file, { kind: 'file', path: 'CHANGES.md', commit: 'c0ffee1', anchor: 'v2' });
    expect(handler).toHaveBeenCalledWith(file, 'CHANGES.md', 'v2');
    await openLinkTarget(forge, { kind: 'file', path: 'docs/a.md', commit: 'worktree', anchor: null });
    expect(api.openUrl).toHaveBeenCalledWith('https://gitlab.example.com/group/project/-/blob/main/docs/a.md');
    off();
  });
});

describe('Ctrl+click and the tooltip', () => {
  it('Ctrl+click always has the forge URL when there is one', () => {
    expect(browserUrlFor(forge, { kind: 'commit', sha: SHA, webUrl: null })).toBe(`https://gitlab.example.com/group/project/-/commit/${SHA}`);
    expect(browserUrlFor(forge, { kind: 'anchor', id: 'user-content-x' })).toBeNull();
  });

  it('shows the full target first', () => {
    expect(linkTooltip(forge, { kind: 'mr', number: 45, webUrl: 'x' })).toBe('Open !45 in GitBolt');
    expect(linkTooltip(forge, { kind: 'commit', sha: SHA, webUrl: null })).toBe('Select abc1234 in the graph');
    expect(linkTooltip(forge, { kind: 'external', url: 'https://example.org/a' })).toBe('https://example.org/a');
  });
});
