import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ openUrl: vi.fn(async () => null), forgeSearchUsers: vi.fn() }));
vi.mock('../api/client', () => ({ api, errorMessage: String }));
const poll = vi.hoisted(() => ({ openMrView: vi.fn(), loadMrDetail: vi.fn(async () => {}), refreshMr: vi.fn(async () => {}) }));
vi.mock('../forge/poll', () => poll);
const copy = vi.hoisted(() => ({ copyText: vi.fn(async () => {}) }));
vi.mock('../api/transport', async (orig) => ({ ...(await orig<typeof import('../api/transport')>()), ...copy }));

const { MdLink } = await import('./MdLink');
const { MdReference } = await import('./MdReference');
const { Markdown } = await import('./Markdown');
const { patchForge, useForge } = await import('../forge/mrStore');
const { projectOf, user } = await import('../forge/testMrs');
const { useMenu } = await import('../menu/menuStore');
const { useRuntime } = await import('../app/runtime');

const ctx = { kind: 'forge', tabId: 't' } as const;
const labels = () => (useMenu.getState().rows ?? []).map((r) => (r.kind === 'separator' ? '---' : r.label));

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  useMenu.getState().close();
  patchForge('t', { kind: 'gitlab', remote: 'origin', project: projectOf() });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
});

describe('MdLink (spec #5 §4.1)', () => {
  it('opens the browser on a plain click, with the URL in an instant tooltip and no href to navigate', async () => {
    render(<MdLink ctx={ctx} href="https://example.org/a">site</MdLink>);
    const link = screen.getByRole('link', { name: 'site' });
    expect(link).not.toHaveAttribute('href');
    fireEvent.mouseEnter(link);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('https://example.org/a');
    fireEvent.click(link);
    expect(api.openUrl).toHaveBeenCalledWith('https://example.org/a');
  });

  it('opens a GFM-autolinked email address as a mailto: link', () => {
    render(<Markdown flavor="github" context={ctx} text="Write to ada@example.com." />);
    fireEvent.click(screen.getByRole('link', { name: 'ada@example.com' }));
    expect(api.openUrl).toHaveBeenCalledWith('mailto:ada@example.com');
  });

  it('opens an MR reference in GitBolt; Ctrl+click opens it in the browser', () => {
    render(<MdReference ctx={ctx} node={{ type: 'reference', refKind: 'mr', project: null, number: 5, sha: null, user: null, value: '!5' }} />);
    const link = screen.getByRole('link', { name: '!5' });
    fireEvent.click(link);
    expect(poll.openMrView).toHaveBeenCalledWith('t', 5);
    fireEvent.click(link, { ctrlKey: true });
    expect(api.openUrl).toHaveBeenCalledWith('https://gitlab.example.com/group/project/-/merge_requests/5');
  });

  it('offers Open in GitBolt, Open in browser, Copy link and Copy text on a right-click', () => {
    render(<MdReference ctx={ctx} node={{ type: 'reference', refKind: 'mr', project: null, number: 5, sha: null, user: null, value: '!5' }} />);
    fireEvent.contextMenu(screen.getByRole('link', { name: '!5' }));
    expect(labels()).toEqual(['Open in GitBolt', 'Open in browser', '---', 'Copy link', 'Copy text']);
    const copyText = useMenu.getState().rows!.find((r) => r.kind === 'action' && r.label === 'Copy text');
    if (copyText?.kind === 'action') copyText.run();
    expect(copy.copyText).toHaveBeenCalledWith('!5');
  });

  it('an external link’s menu has no Open in GitBolt; a script link is plain text', () => {
    render(<><MdLink ctx={ctx} href="https://example.org/a">site</MdLink><MdLink ctx={ctx} href="javascript:alert(1)">bad</MdLink></>);
    fireEvent.contextMenu(screen.getByRole('link', { name: 'site' }));
    expect(labels()).toEqual(['Open in browser', '---', 'Copy link', 'Copy text']);
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(screen.getByText('bad')).toHaveClass('md-inert');
  });

  it('@user shows a hover card from the forge user lookup and opens the profile', async () => {
    api.forgeSearchUsers.mockResolvedValue([user('Ada Lovelace')]);
    render(<MdReference ctx={ctx} node={{ type: 'reference', refKind: 'mention', project: null, number: null, sha: null, user: 'ada', value: '@ada' }} />);
    const link = screen.getByRole('link', { name: '@ada' });
    fireEvent.mouseEnter(link);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Ada Lovelace');
    expect(api.forgeSearchUsers).toHaveBeenCalledWith(4, 'origin', 'ada');
    fireEvent.click(link);
    expect(api.openUrl).toHaveBeenCalledWith('https://gitlab.example.com/ada');
  });

  it('keeps the anchor’s id, name and aria-describedby: footnote and <a name> targets', async () => {
    const { container } = render(<div className="md-rendered"><Markdown flavor="github" context={ctx} text={'<a name="top"></a>\n\nA note[^1] and [up](#top).\n\n[^1]: Footnote.'} /></div>);
    const ref = container.querySelector('#user-content-fnref-1')!;
    expect(ref).toHaveAttribute('aria-describedby', 'user-content-footnote-label');
    expect(container.querySelector('a[name="user-content-top"]')).toHaveClass('md-inert');
    const up = screen.getByRole('link', { name: 'up' });
    const target = container.querySelector('a[name="user-content-top"]') as HTMLElement;
    target.scrollIntoView = vi.fn();
    // Only the document's own pane scrolls: the target to its top.
    const pane = container.querySelector('.md-rendered') as HTMLElement;
    pane.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    target.getBoundingClientRect = () => ({ top: 400 }) as DOMRect;
    fireEvent.click(up);
    await vi.waitFor(() => expect(pane.scrollTop).toBe(300));
    expect(target.scrollIntoView).not.toHaveBeenCalled();
  });
});
