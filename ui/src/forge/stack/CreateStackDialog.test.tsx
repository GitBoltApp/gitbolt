import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import { useRuntime } from '../../app/runtime';
import { useToast } from '../../ui/toast';
import { CreateStackDialog, openCreateStack } from './CreateStackDialog';

const createMr = vi.fn();
const project = { kind: 'gitlab' as const, id: 42, host: 'gitlab.example.com', path: 'group/project', name: 'project', owner: 'group', webUrl: '', defaultBranch: 'main', cloneHttps: '', cloneSsh: '', forkOf: null, updatedAt: null, archived: false };
vi.mock('./deps', () => ({ createMr: (...a: unknown[]) => createMr(...a), forgeTarget: () => ({ remote: 'origin', kind: 'gitlab', project }) }));

const mr = (number: number, source: string, target: string, state: ForgeMr['state'] = 'open'): ForgeMr => ({
  number, title: `MR ${number}`, state, author: { id: 1, username: 'ada', name: 'Ada', avatarUrl: null, webUrl: '', email: null },
  sourceProject: 'group/project', sourceBranch: source, targetProject: 'group/project', targetBranch: target, headSha: null,
  webUrl: '', pipeline: null, review: { decision: 'none', approvals: 0, approvalsRequired: null, reviews: [] }, conflicts: false, labels: [], labelColors: {}, updatedAt: number, autoMerge: null, stacked: false,
});
const stack = { branches: ['feature/a', 'feature/b'], base: 'refs/remotes/origin/main', leftBehind: [] };

describe('Create stack MRs (spec #4 §4 4D)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    createMr.mockReset();
    useToast.getState().dismiss();
    useRuntime.getState().patch('t', { repo: { id: 1, path: '/r', name: 'r', worktree: '/r' }, worktree: '/r' } as never);
  });

  it('lists each member with its target, prefills new titles, creates bottom first and says what it did', async () => {
    const load = vi.spyOn(api, 'forgeStack').mockResolvedValue({ remote: 'origin', project: 'group/project', kind: 'gitlab', mode: 'managed', members: [
      { branch: 'feature/a', targetBranch: 'main', mr: mr(1, 'feature/a', 'main'), prefill: null },
      { branch: 'feature/b', targetBranch: 'feature/a', mr: null, prefill: { title: 'Work on feature/b', description: '' } },
    ] });
    createMr.mockResolvedValue({ mr: mr(2, 'feature/b', 'feature/a'), failed: [] });
    vi.spyOn(api, 'forgeSyncStack').mockResolvedValue({ edited: [1, 2], unchanged: [], failed: [] });
    render(<CreateStackDialog />);
    act(() => openCreateStack('t', stack));
    const dialog = await screen.findByRole('dialog', { name: 'Create stack MRs' });
    expect(load).toHaveBeenCalledWith(1, ['feature/a', 'feature/b'], 'main', 'refs/remotes/origin/main');
    expect(await screen.findByText('Each MR targets the branch below it. GitBolt keeps a Stack table in every description up to date.')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('feature/a → main');
    expect(dialog).toHaveTextContent('!1 is open');
    const title = screen.getByRole('textbox', { name: 'Title for feature/b' });
    expect(title).toHaveValue('Work on feature/b');
    fireEvent.change(title, { target: { value: 'Use the parser' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Create as drafts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create 1 MR' }));
    await waitFor(() => expect(useToast.getState().message).toBe('Created !2'));
    expect(createMr.mock.calls[0][1]).toMatchObject({ targetBranch: 'feature/a', title: 'Use the parser', draft: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a merged member blocks it: the stack needs its after-merge rebase first', async () => {
    vi.spyOn(api, 'forgeStack').mockResolvedValue({ remote: 'origin', project: 'group/project', kind: 'gitlab', mode: 'native', members: [
      { branch: 'feature/a', targetBranch: 'main', mr: mr(1, 'feature/a', 'main', 'merged'), prefill: null },
      { branch: 'feature/b', targetBranch: 'feature/a', mr: null, prefill: { title: 'B', description: '' } },
    ] });
    render(<CreateStackDialog />);
    act(() => openCreateStack('t', stack));
    expect(await screen.findByText('!1 is merged: rebase the stack first')).toBeInTheDocument();
    expect(screen.getByText('Each MR targets the branch below it. GitLab shows them as a stack.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create 1 MR' })).toBeDisabled();
  });

  it("a stack it can't load says why", async () => {
    vi.spyOn(api, 'forgeStack').mockRejectedValue({ kind: 'Network', message: "Couldn't reach gitlab.example.com: timed out", commandId: null, stderr: null });
    render(<CreateStackDialog />);
    act(() => openCreateStack('t', stack));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach gitlab.example.com: timed out");
  });

  it('Enter in a title creates nothing; Ctrl+Enter does', async () => {
    vi.spyOn(api, 'forgeStack').mockResolvedValue({ remote: 'origin', project: 'group/project', kind: 'gitlab', mode: 'native', members: [
      { branch: 'feature/b', targetBranch: 'main', mr: null, prefill: { title: 'B', description: '' } },
    ] });
    createMr.mockResolvedValue({ mr: mr(2, 'feature/b', 'main'), failed: [] });
    render(<CreateStackDialog />);
    act(() => openCreateStack('t', { ...stack, branches: ['feature/b'] }));
    const title = await screen.findByRole('textbox', { name: 'Title for feature/b' });
    fireEvent.keyDown(title, { key: 'Enter' });
    fireEvent.submit(title.closest('form')!);
    expect(createMr).not.toHaveBeenCalled();
    fireEvent.keyDown(title, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(createMr).toHaveBeenCalledTimes(1));
  });

  it('a click and a Ctrl+Enter in the same tick start one run, with a progress toast', async () => {
    vi.spyOn(api, 'forgeStack').mockResolvedValue({ remote: 'origin', project: 'group/project', kind: 'gitlab', mode: 'native', members: [
      { branch: 'feature/b', targetBranch: 'main', mr: null, prefill: { title: 'B', description: '' } },
    ] });
    createMr.mockImplementation(() => new Promise(() => {}));
    render(<CreateStackDialog />);
    act(() => openCreateStack('t', { ...stack, branches: ['feature/b'] }));
    const title = await screen.findByRole('textbox', { name: 'Title for feature/b' });
    fireEvent.click(screen.getByRole('button', { name: 'Create 1 MR' }));
    fireEvent.keyDown(title, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(createMr).toHaveBeenCalledTimes(1));
    expect(useToast.getState().message).toBe("Creating the stack's MRs…");
  });
});
