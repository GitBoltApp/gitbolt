import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  forgeRepoProjects: vi.fn(), forgeCreateContext: vi.fn(), forgeCreateMr: vi.fn(),
  forgeSearchUsers: vi.fn(async () => []), forgeLabels: vi.fn(async () => []), openUrl: vi.fn(async () => null),
}));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message: string }).message) }));
const transport = vi.hoisted(() => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));
vi.mock('../../api/transport', () => transport);
const notifyForgeWrite = vi.hoisted(() => vi.fn());
vi.mock('../usePolling', () => ({ notifyForgeWrite }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../ui/ConfirmDialog', () => ({ confirmAction: confirm }));
const showCreated = vi.hoisted(() => vi.fn());
vi.mock('./outcome', () => ({ showCreated }));
const pushBranch = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../sync/push', () => ({ pushBranch }));

const { CreateMrFlyout } = await import('./CreateMrFlyout');
const { discardMrDraft, readMrDraft, writeMrDraft } = await import('./draft');
const { useRuntime } = await import('../../app/runtime');
const { EMPTY_FORGE, patchForge, useForge } = await import('../mrStore');
const { useToast } = await import('../../ui/toast');

const feature = {
  name: 'feature/login', fullName: 'refs/heads/feature/login', target: 'a'.repeat(40), upstream: 'refs/remotes/origin/feature/login', ahead: 0, behind: 0, gone: false,
  tipTime: 0, summary: '', author: '', isHead: true, worktree: null, checkedOut: null, pushTarget: 'origin/feature/login', pushBehind: 0, rewritten: null,
};
const remoteBranch = (name: string) => ({ name, fullName: `refs/remotes/origin/${name}`, target: 'b'.repeat(40), tipTime: 0, summary: '', author: '' });
function setRuntime(onOrigin = ['main', 'feature/login'], local: object = feature) {
  useRuntime.setState({ tabs: { t1: { status: 'ready', repo: { id: 7, name: 'shop', path: '/r/shop' }, worktree: '/r/shop', sidebar: {
    locals: [local], remotes: [{ name: 'origin', host: 'gitlab.example.com', hostKind: 'gitlab', branches: onOrigin.map(remoteBranch) }], tags: [], stashes: [], worktrees: [],
  } } } } as never);
}
const project = {
  kind: 'gitlab', id: 42, host: 'gitlab.example.com', path: 'group/project', name: 'project', owner: 'group', webUrl: 'https://gitlab.example.com/group/project',
  defaultBranch: 'main', cloneHttps: '', cloneSsh: '', forkOf: null, updatedAt: null, archived: false,
};
const CTX = {
  project, sourceProject: 'group/project', settings: { mergeMethods: ['merge'], squash: 'defaultOn', deleteSourceBranch: true },
  templates: [{ name: 'Default', path: '.gitlab/merge_request_templates/Default.md', body: '## Checklist' }], templatesLocal: false,
  firstCommit: { summary: 'Add login', body: 'Why it matters.', count: 2 },
};

beforeEach(() => {
  vi.clearAllMocks();
  discardMrDraft('/r/shop', 'feature/login');
  useForge.setState({ byTab: { t1: { ...EMPTY_FORGE } } });
  useToast.getState().dismiss();
  setRuntime();
  patchForge('t1', { kind: 'gitlab', remote: 'origin', project: project as never });
  api.forgeRepoProjects.mockResolvedValue({ remotes: [{ remote: 'origin', host: 'gitlab.example.com', path: 'group/project', account: 'gitlab', project, error: null }], target: 'origin' });
  api.forgeCreateContext.mockResolvedValue(CTX);
});

const closed = vi.fn();
/** What 4B's host does: mounts the flyout with its props and unmounts it when `close` is called. */
function Host() {
  const [open, setOpen] = useState(true);
  return open ? <CreateMrFlyout tabId="t1" props={{ branch: 'feature/login' }} close={() => { closed(); setOpen(false); }} /> : null;
}
async function show() {
  render(<Host />);
  await screen.findByLabelText('Title');
  return screen.getByRole('dialog', { name: 'Create merge request' });
}
const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
const checked = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).checked;
const createButton = () => screen.getByRole('button', { name: 'Create merge request' }) as HTMLButtonElement;

describe('the Create flyout (spec #4 §4 "4C")', () => {
  it('prefills from the first commit and the default template, and saves nothing until edited', async () => {
    await show();
    expect(api.forgeCreateContext).toHaveBeenCalledWith(7, 'origin', 'origin', 'feature/login', 'main');
    expect([value('Title'), value('Description')]).toEqual(['Add login', 'Why it matters.\n\n## Checklist']);
    expect([checked('Squash commits when merging'), checked('Delete the source branch when merged'), checked('Mark as draft')]).toEqual([true, true, false]);
    expect(readMrDraft('/r/shop', 'feature/login')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard draft' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Add the login page' } });
    expect(readMrDraft('/r/shop', 'feature/login')?.title).toBe('Add the login page');
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeTruthy();
  });

  it('creates, discards the draft and closes; the outcome goes to the toast', async () => {
    api.forgeCreateMr.mockResolvedValue({ mr: { number: 12, webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/12' }, failed: [] });
    await show();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Add login!' } });
    fireEvent.click(createButton());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.forgeCreateMr).toHaveBeenCalledWith(7, 'origin', expect.objectContaining({
      source: { project: 'group/project', branch: 'feature/login' }, targetBranch: 'main', title: 'Add login!', squash: true, deleteSourceBranch: true,
    }));
    expect(showCreated).toHaveBeenCalledWith(expect.objectContaining({ repoId: 7, remote: 'origin', kind: 'gitlab', number: 12 }), []);
    expect(notifyForgeWrite).toHaveBeenCalledWith('t1');
    expect(closed).toHaveBeenCalled();
    expect(readMrDraft('/r/shop', 'feature/login')).toBeNull();
  });

  it('a failed create keeps the flyout and the draft, and says why', async () => {
    api.forgeCreateMr.mockRejectedValue({ message: 'gitlab.example.com: Another open merge request already exists for this source branch: !1' });
    await show();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Add login, again' } });
    fireEvent.click(createButton());
    expect((await screen.findByRole('alert')).textContent).toBe('gitlab.example.com: Another open merge request already exists for this source branch: !1');
    expect(screen.getByRole('dialog', { name: 'Create merge request' })).toBeTruthy();
    expect(readMrDraft('/r/shop', 'feature/login')?.title).toBe('Add login, again');
  });

  it("a branch not on the remote yet can't be created: Push it first", async () => {
    setRuntime(['main'], { ...feature, upstream: null, pushTarget: null, pushBehind: null });
    await show();
    expect(screen.getByText('Push feature/login to origin first')).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Push feature/login' }));
    expect(pushBranch).toHaveBeenCalledWith({ tabId: 't1', repoId: 7, worktree: '/r/shop' }, expect.objectContaining({ name: 'feature/login' }));
    expect(api.forgeCreateMr).not.toHaveBeenCalled();
  });

  it('resumes a saved draft, and Discard arms in place before deleting it', async () => {
    writeMrDraft('/r/shop', 'feature/login', {
      sourceRemote: 'origin', targetRemote: 'origin', targetBranch: 'main', title: 'Saved title', description: 'Saved', prefilled: '', template: null,
      reviewers: [], assignees: [], labels: [], draft: true, squash: false, deleteSourceBranch: false,
    });
    await show();
    expect([value('Title'), checked('Mark as draft')]).toEqual(['Saved title', true]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ arm: 'Click again to discard the draft', danger: true }));
    expect(readMrDraft('/r/shop', 'feature/login')).toBeNull();
  });

  it("Continue editing opens the forge's prefilled page and keeps the flyout", async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Continue editing on GitLab' }));
    expect(api.openUrl).toHaveBeenCalledWith(expect.stringContaining('https://gitlab.example.com/group/project/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Flogin'));
    expect(screen.getByRole('dialog', { name: 'Create merge request' })).toBeTruthy();
  });

  it('a description too long for the link goes to the clipboard, and the toast says so', async () => {
    api.forgeCreateContext.mockResolvedValue({ ...CTX, templates: [], firstCommit: { summary: 'x', body: 'y'.repeat(9000), count: 1 } });
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Continue editing on GitLab' }));
    expect(api.openUrl).toHaveBeenCalledWith(expect.not.stringContaining('description'));
    expect(transport.copyText).toHaveBeenCalledWith('y'.repeat(9000));
    expect(useToast.getState().message).toBe("The description is too long for the link: it's on the clipboard to paste on GitLab");
  });

  it('a project that always squashes locks the checkbox and says so', async () => {
    api.forgeCreateContext.mockResolvedValue({ ...CTX, settings: { ...CTX.settings, squash: 'always' } });
    await show();
    const squash = screen.getByLabelText('Squash commits when merging') as HTMLInputElement;
    expect([squash.checked, squash.disabled]).toEqual([true, true]);
    expect(screen.getByText('This project always squashes')).toBeTruthy();
  });

  it('a failed route change reverts, keeps the form and the title input; a reopen uses the good route', async () => {
    await show();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Mine' } });
    const input = screen.getByLabelText('Title');
    input.focus();
    api.forgeCreateContext.mockRejectedValueOnce({ message: 'boom' });
    fireEvent.click(screen.getByRole('button', { name: 'Target branch' }));
    fireEvent.click((await screen.findAllByText('feature/login')).at(-1)!);
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load origin/feature/login: boom");
    expect(screen.getByLabelText('Title')).toBe(input);
    expect(readMrDraft('/r/shop', 'feature/login')?.targetBranch).toBe('main');
  });
});
