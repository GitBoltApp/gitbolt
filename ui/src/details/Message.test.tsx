import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openUrl = vi.hoisted(() => vi.fn(async (_url: string): Promise<null> => null));
vi.mock('../api/client', () => ({ api: { openUrl }, errorMessage: (e: { message: string }) => e.message }));

import { useToast } from '../ui/toast';
import { fakeServices } from '../repo/testServices';
import { Message, useProjectRemote } from './Message';
import type { ProjectRemote } from './messageLinks';

const gitlab: ProjectRemote = { host: 'gitlab.example.com', path: 'group/project', hostKind: 'gitlab' };
const github: ProjectRemote = { host: 'github.com', path: 'owner/repo', hostKind: 'github' };
const body = 'Refs !42 and group/sub/project!7, fixes #12.\nSee https://example.com/docs for details.\nAgain !42.';

beforeEach(() => {
  openUrl.mockClear();
  useToast.setState({ message: null });
});

describe('Message', () => {
  it('linkifies the summary and body and adds one Open button per distinct merge request', () => {
    render(<Message summary="Fix !3" body={body} remote={gitlab} />);
    expect(screen.getByTestId('details-summary')).toHaveTextContent('Fix !3');
    expect(within(screen.getByTestId('details-summary')).getByRole('link', { name: '!3' })).toHaveAttribute('href', 'https://gitlab.example.com/group/project/-/merge_requests/3');
    const bodyEl = screen.getByTestId('details-body');
    expect(bodyEl.textContent).toBe(body);
    expect(within(bodyEl).getByRole('link', { name: '#12' })).toHaveAttribute('href', 'https://gitlab.example.com/group/project/-/issues/12');
    expect(within(bodyEl).getByRole('link', { name: 'https://example.com/docs' })).toHaveAttribute('href', 'https://example.com/docs');
    const buttons = screen.getAllByRole('button', { name: /^Open / });
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Open !3', 'Open !42', 'Open group/sub/project!7']);
    expect(buttons[2]).toHaveAttribute('data-url', 'https://gitlab.example.com/group/sub/project/-/merge_requests/7');
  });

  it('an Open button opens the merge request in the browser through the backend', async () => {
    render(<Message summary="s" body={body} remote={gitlab} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open group/sub/project!7' })));
    expect(openUrl).toHaveBeenCalledExactlyOnceWith('https://gitlab.example.com/group/sub/project/-/merge_requests/7');
    expect(useToast.getState().message).toBeNull();
  });

  it('a link click opens the URL through the backend instead of navigating the app', async () => {
    render(<Message summary="s" body={body} remote={gitlab} />);
    const link = screen.getByRole('link', { name: 'https://example.com/docs' });
    let notPrevented = true;
    await act(async () => { notPrevented = fireEvent.click(link); });
    expect(notPrevented).toBe(false);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/docs');
  });

  it('a failed open shows a toast', async () => {
    openUrl.mockRejectedValueOnce({ message: 'no browser' });
    render(<Message summary="s" body={body} remote={gitlab} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open !42' })));
    expect(useToast.getState().message).toBe('no browser');
  });

  it('GitHub #n references are pull requests (link and button); no remote links URLs only', () => {
    const { unmount } = render(<Message summary="Closes #5" body="" remote={github} />);
    expect(screen.getByRole('link', { name: '#5' })).toHaveAttribute('href', 'https://github.com/owner/repo/pull/5');
    expect(screen.getByRole('button', { name: 'Open #5' })).toHaveAttribute('data-url', 'https://github.com/owner/repo/pull/5');
    expect(screen.queryByTestId('details-body')).toBeNull();
    unmount();
    render(<Message summary="Closes #5 !6" body="at https://x.example/a." remote={null} />);
    expect(screen.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['https://x.example/a']);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('useProjectRemote', () => {
  it('resolves once per repo: a later mount has the remote in its first render (no relink frame)', async () => {
    const remotes = vi.fn(async () => [{ name: 'origin', host: 'gitlab.example.com', path: 'group/project', hostKind: 'gitlab' as const }]);
    const services = fakeServices({ remotes });
    const first = renderHook(() => useProjectRemote(services));
    expect(first.result.current).toBeNull();
    await act(async () => {});
    expect(first.result.current).toEqual(gitlab);
    first.unmount();
    const renders: (ProjectRemote | null)[] = [];
    renderHook(() => { const r = useProjectRemote(services); renders.push(r); return r; });
    expect(renders[0]).toEqual(gitlab);
    expect(remotes).toHaveBeenCalledTimes(1);
  });
});
