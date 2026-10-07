import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  forgeRepoProjects: vi.fn(), forgeCreateContext: vi.fn(), forgeCreateMr: vi.fn(),
  forgeSearchUsers: vi.fn(async () => []), forgeLabels: vi.fn(async () => []), openUrl: vi.fn(async () => null),
  forgeAccounts: vi.fn(async () => []), mergeBase: vi.fn(async () => null), fileList: vi.fn(),
  forgePeopleLimits: vi.fn(async () => ({ maxReviewers: null, maxAssignees: null })),
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
const openPushUpstream = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../sync/push', () => ({ pushBranch, openPushUpstream }));

const { CreateMrFlyout } = await import('./CreateMrFlyout');
const { discardMrDraft, readMrDraft, writeMrDraft } = await import('./draft');
const { useRuntime } = await import('../../app/runtime');
const { resetPeopleLimits } = await import('../peopleLimits');
const { EMPTY_FORGE, patchForge, useForge } = await import('../mrStore');
const { useToast } = await import('../../ui/toast');
const { useMenu } = await import('../../menu/menuStore');
const { closeFlyout, openFlyout, registerFlyout } = await import('../../ui/flyout/flyout');
registerFlyout('other', () => null);

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
  resetPeopleLimits();
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
const on = (name: string) => screen.getByRole('switch', { name }).getAttribute('aria-checked') === 'true';
const createButton = (name = 'Create merge request') => screen.getByRole('button', { name }) as HTMLButtonElement;
/** Runs a row of the app menu the last Select or menu button opened. */
const runMenu = (label: string) => act(() => {
  (useMenu.getState().rows!.find((r) => r.kind === 'action' && r.label === label) as { run(): void }).run();
  useMenu.getState().close();
});
/** + Add on a PeopleCard row, then its search box. */
function addTo(noun: string, label: string) {
  fireEvent.click(screen.getByRole('button', { name: `Add ${noun}` }));
  return screen.getByLabelText(label);
}

describe('the Create flyout (spec #4 §4 "4C")', () => {
  it('prefills from the first commit and the default template, and saves nothing until edited', async () => {
    await show();
    expect(api.forgeCreateContext).toHaveBeenCalledWith(7, 'origin', 'origin', 'feature/login', 'main');
    expect([value('Title'), value('Description')]).toEqual(['Add login', 'Why it matters.\n\n## Checklist']);
    expect(['Title', 'Description'].map((l) => screen.getByLabelText(l).getAttribute('spellcheck'))).toEqual(['true', 'true']);
    expect([on('Squash commits'), on('Delete the source branch')]).toEqual([true, true]);
    expect(createButton()).toBeTruthy();
    expect(screen.getByText('from the first commit')).toBeTruthy();
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

  it('Enter never creates (title, a picker with no matches, mid-debounce or after an error); Ctrl+Enter does', async () => {
    api.forgeCreateMr.mockResolvedValue({ mr: { number: 12, webUrl: 'w' }, failed: [] });
    await show();
    fireEvent.keyDown(screen.getByLabelText('Title'), { key: 'Enter' });
    fireEvent.submit(screen.getByLabelText('Title').closest('form')!);
    const reviewers = addTo('reviewer', 'Reviewers');
    fireEvent.focus(reviewers);
    fireEvent.change(reviewers, { target: { value: 'nobody' } });
    fireEvent.keyDown(reviewers, { key: 'Enter' });
    await screen.findByText('No matches');
    fireEvent.keyDown(reviewers, { key: 'Enter' });
    api.forgeLabels.mockRejectedValueOnce({ message: 'labels down' });
    const labels = addTo('label', 'Labels');
    fireEvent.focus(labels);
    expect((await screen.findByText('labels down')).textContent).toBe('labels down');
    fireEvent.keyDown(labels, { key: 'Enter' });
    expect(api.forgeCreateMr).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('Title'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.forgeCreateMr).toHaveBeenCalledTimes(1));
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

  it('while creating, the fields and pickers are read-only; the error shows in the pinned footer, over the buttons', async () => {
    let fail: (e: unknown) => void = () => {};
    api.forgeCreateMr.mockReturnValue(new Promise((_, r) => { fail = r; }));
    await show();
    createButton().focus();
    fireEvent.click(createButton());
    await screen.findByRole('button', { name: 'Creating…' });
    for (const label of ['Title', 'Description']) expect(screen.getByLabelText(label).matches(':disabled')).toBe(true);
    for (const name of ['Add reviewer', 'Add assignee', 'Add label', 'Target branch', 'More create options']) expect(screen.getByRole('button', { name }).matches(':disabled')).toBe(true);
    expect(screen.getByRole('switch', { name: 'Squash commits' }).matches(':disabled')).toBe(true);
    fail({ message: 'boom' });
    const alert = await screen.findByRole('alert');
    expect(screen.getByLabelText('Title').matches(':disabled')).toBe(false);
    expect(alert.closest('.flyout-foot')).not.toBeNull();
    expect(alert.compareDocumentPosition(createButton().closest('.create-mr-actions')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(createButton()));
  });

  it("a create that lands after another flyout opened doesn't close that one", async () => {
    let answer: (v: unknown) => void = () => {};
    api.forgeCreateMr.mockReturnValue(new Promise((r) => { answer = r; }));
    openFlyout('t1', 'other', {});
    await show();
    fireEvent.click(createButton());
    await screen.findByRole('button', { name: 'Creating…' });
    openFlyout('t1', 'other', {});
    answer({ mr: { number: 12, webUrl: 'w' }, failed: [] });
    await waitFor(() => expect(showCreated).toHaveBeenCalled());
    expect(closed).not.toHaveBeenCalled();
    closeFlyout('t1');
  });

  it('a create that fails after the flyout closed says so in a toast and keeps the draft', async () => {
    let fail: (e: unknown) => void = () => {};
    api.forgeCreateMr.mockReturnValue(new Promise((_, r) => { fail = r; }));
    await show();
    fireEvent.click(createButton());
    await screen.findByRole('button', { name: 'Creating…' });
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fail({ message: 'boom' });
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't create merge request from feature/login: boom; the draft is kept"));
    expect(useToast.getState().tone).toBe('warning');
    expect(readMrDraft('/r/shop', 'feature/login')?.title).toBe('Add login');
  });

  it("a branch not on the remote yet can't be created: Push it first", async () => {
    setRuntime(['main'], { ...feature, upstream: null, pushTarget: null, pushBehind: null });
    await show();
    expect(document.querySelector('.flow-strip')).toHaveTextContent("feature/login isn't on origin yet.");
    expect(createButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Push feature/login' }));
    expect(pushBranch).toHaveBeenCalledWith({ tabId: 't1', repoId: 7, worktree: '/r/shop' }, expect.objectContaining({ name: 'feature/login' }));
    expect(api.forgeCreateMr).not.toHaveBeenCalled();
  });

  it('a branch tracking the target branch (made from origin/main) is offered as itself, and its push asks where', async () => {
    setRuntime(['main'], { ...feature, upstream: 'refs/remotes/origin/main', pushTarget: 'origin/main' });
    await show();
    expect(document.querySelector('.flow-strip')).toHaveTextContent("feature/login isn't on origin yet.");
    expect(screen.queryByText("main can't target itself")).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Push feature/login…' }));
    expect(openPushUpstream).toHaveBeenCalled();
    expect(pushBranch).not.toHaveBeenCalled();
  });

  it("the unpushed count is against the source remote's branch: unknown when that isn't the upstream", async () => {
    setRuntime(['main', 'feature/login'], { ...feature, ahead: 2 });
    await show();
    expect(screen.getByText("2 commits aren't pushed yet: the merge request shows what origin has")).toBeTruthy();
    cleanup();
    setRuntime(['main', 'feature/login'], { ...feature, upstream: 'refs/remotes/origin/main', ahead: 4, pushTarget: 'origin/feature/login' });
    await show();
    expect(screen.getByText('feature/login differs from origin/feature/login: the merge request shows what origin has')).toBeTruthy();
  });

  it('resumes a saved draft, and Discard arms in place before deleting it', async () => {
    writeMrDraft('/r/shop', 'feature/login', {
      sourceRemote: 'origin', targetRemote: 'origin', targetBranch: 'main', title: 'Saved title', description: 'Saved', prefilled: '', template: null,
      reviewers: [], assignees: [], labels: [], draft: true, squash: false, deleteSourceBranch: false,
    });
    await show();
    expect(value('Title')).toBe('Saved title');
    // The saved draft flag is the split button's choice: its main button creates a draft.
    expect(createButton('Create draft merge request')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ arm: 'Click again to discard the draft', danger: true }));
    expect(readMrDraft('/r/shop', 'feature/login')).toBeNull();
  });

  it('From and To offer only the remotes on the target forge: an unmapped push remote is left out', async () => {
    setRuntime(['main', 'feature/login'], { ...feature, pushTarget: 'mirror/feature/login' });
    useRuntime.setState((s) => {
      const t = s.tabs.t1 as never as { sidebar: { remotes: object[] } };
      t.sidebar.remotes.push({ name: 'mirror', host: 'git.example.org', hostKind: 'unknown', branches: [remoteBranch('feature/login')] });
      return s;
    });
    await show();
    expect(api.forgeCreateContext).toHaveBeenCalledWith(7, 'origin', 'origin', 'feature/login', 'main');
    expect(screen.queryByText('mirror')).toBeNull();
  });

  it("Continue on GitLab opens the forge's prefilled page and keeps the flyout", async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Continue on GitLab' }));
    expect(api.openUrl).toHaveBeenCalledWith(expect.stringContaining('https://gitlab.example.com/group/project/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Flogin'));
    expect(screen.getByRole('dialog', { name: 'Create merge request' })).toBeTruthy();
  });

  it('a description too long for the link goes to the clipboard, and the toast says so', async () => {
    api.forgeCreateContext.mockResolvedValue({ ...CTX, templates: [], firstCommit: { summary: 'x', body: 'y'.repeat(9000), count: 1 } });
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Continue on GitLab' }));
    expect(api.openUrl).toHaveBeenCalledWith(expect.not.stringContaining('description'));
    expect(transport.copyText).toHaveBeenCalledWith('y'.repeat(9000));
    expect(useToast.getState().message).toBe("The description is too long for the link: it's on the clipboard to paste on GitLab");
  });

  it('a project that always squashes locks the switch and says so', async () => {
    api.forgeCreateContext.mockResolvedValue({ ...CTX, settings: { ...CTX.settings, squash: 'always' } });
    await show();
    const squash = screen.getByRole('switch', { name: 'Squash commits' }) as HTMLButtonElement;
    expect([on('Squash commits'), squash.disabled]).toEqual([true, true]);
    expect(squash).toHaveAccessibleDescription('This project always squashes');
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

  it("the split button's ▾ creates as draft: the request says draft", async () => {
    api.forgeCreateMr.mockResolvedValue({ mr: { number: 12, webUrl: 'w' }, failed: [] });
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'More create options' }));
    expect(useMenu.getState().rows!.map((r) => (r.kind === 'action' ? r.label : ''))).toEqual(['Create merge request', 'Create as draft']);
    runMenu('Create as draft');
    await waitFor(() => expect(api.forgeCreateMr).toHaveBeenCalledWith(7, 'origin', expect.objectContaining({ draft: true, title: 'Add login' })));
  });

  it("the Template picker in the description's header replaces the description as the row did", async () => {
    await show();
    const template = screen.getByRole('button', { name: 'Template' });
    expect(template).toHaveTextContent('Template: Default');
    expect(template.closest('.md-field-tools')).not.toBeNull();
    fireEvent.click(template);
    runMenu('No template');
    expect(value('Description')).toBe('Why it matters.');
    expect(screen.getByRole('button', { name: 'Template' })).toHaveTextContent('Template: none');
    expect(confirm).not.toHaveBeenCalled();
    // Edited: the template asks before it replaces the text.
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Template' }));
    runMenu('Default');
    await waitFor(() => expect(value('Description')).toBe('Why it matters.\n\n## Checklist'));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ arm: 'Click again to replace your description' }));
  });

  it('people: + Add searches and adds a chip, × removes it; Assign to me adds the account user', async () => {
    const grace = { id: 5, username: 'grace', name: 'Grace Hopper', avatarUrl: null, webUrl: '', email: null };
    const ada = { id: 9, username: 'ada', name: 'Ada Lovelace', avatarUrl: null, webUrl: '', email: null };
    api.forgeSearchUsers.mockResolvedValue([grace] as never);
    api.forgeAccounts.mockResolvedValue([{ account: { host: 'gitlab.example.com', kind: 'gitlab', user: ada }, status: { kind: 'ok' } }] as never);
    api.forgeCreateMr.mockResolvedValue({ mr: { number: 12, webUrl: 'w' }, failed: [] });
    await show();
    const people = screen.getByRole('group', { name: 'People and labels' });
    const box = addTo('reviewer', 'Reviewers');
    fireEvent.change(box, { target: { value: 'gr' } });
    fireEvent.click(await screen.findByRole('option', { name: /Grace Hopper/ }));
    expect(within(people).getByText('Grace Hopper')).toBeTruthy();
    // Esc closes the search, not the flyout.
    fireEvent.keyDown(screen.getByLabelText('Reviewers'), { key: 'Escape' });
    expect(screen.queryByLabelText('Reviewers')).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    fireEvent.click(await within(people).findByRole('button', { name: 'Assign to me' }));
    expect(within(people).getByText('Ada Lovelace')).toBeTruthy();
    fireEvent.click(createButton());
    await waitFor(() => expect(api.forgeCreateMr).toHaveBeenCalledWith(7, 'origin', expect.objectContaining({ reviewers: [5], assignees: [9] })));
  });

  // --- MR round 2 ---
  it('a project that allows one reviewer: once picked, + is Replace, and the next pick replaces them', async () => {
    const grace = { id: 5, username: 'grace', name: 'Grace Hopper', avatarUrl: null, webUrl: '', email: null };
    const ada = { id: 9, username: 'ada', name: 'Ada Lovelace', avatarUrl: null, webUrl: '', email: null };
    api.forgePeopleLimits.mockResolvedValueOnce({ maxReviewers: 1, maxAssignees: 1 } as never);
    api.forgeSearchUsers.mockResolvedValue([grace, ada] as never);
    api.forgeCreateMr.mockResolvedValue({ mr: { number: 12, webUrl: 'w' }, failed: [] });
    await show();
    const people = screen.getByRole('group', { name: 'People and labels' });
    fireEvent.change(addTo('reviewer', 'Reviewers'), { target: { value: 'g' } });
    fireEvent.click(await screen.findByRole('option', { name: /Grace Hopper/ }));
    fireEvent.keyDown(screen.getByLabelText('Reviewers'), { key: 'Escape' });
    const swap = within(people).getByRole('button', { name: 'Replace reviewer' });
    fireEvent.mouseEnter(swap);
    expect(screen.getByRole('tooltip')).toHaveTextContent('This project allows one reviewer');
    fireEvent.click(swap);
    fireEvent.change(screen.getByLabelText('Reviewers'), { target: { value: 'a' } });
    fireEvent.click(await screen.findByRole('option', { name: /Ada Lovelace/ }));
    expect(within(people).queryByText('Grace Hopper')).toBeNull();
    fireEvent.click(createButton());
    await waitFor(() => expect(api.forgeCreateMr).toHaveBeenCalledWith(7, 'origin', expect.objectContaining({ reviewers: [9] })));
  });
  // --- end MR round 2 ---

  it('× on a chip removes it from the draft', async () => {
    writeMrDraft('/r/shop', 'feature/login', {
      sourceRemote: 'origin', targetRemote: 'origin', targetBranch: 'main', title: 'T', description: '', prefilled: '', template: null,
      reviewers: [{ id: 5, username: 'grace', name: 'Grace Hopper', avatarUrl: null, webUrl: '', email: null }], assignees: [], labels: ['bug'], draft: false, squash: true, deleteSourceBranch: true,
    });
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Grace Hopper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove bug' }));
    expect(readMrDraft('/r/shop', 'feature/login')).toMatchObject({ reviewers: [], labels: [] });
  });

  it("the branch card counts what the branch brings from local reads, and lists its commits", async () => {
    const [tip, mid, base] = ['a'.repeat(40), 'd'.repeat(40), 'c'.repeat(40)];
    const row = (id: string, parent: string, summary: string) => ({ id, parents: [parent], summary, wip: null });
    useRuntime.setState((s) => { (s.tabs.t1 as never as { graph: object }).graph = { rows: [row(tip, mid, 'Polish login'), row(mid, base, 'Add login'), row(base, 'e'.repeat(40), 'Base')], labels: [] }; return s; });
    api.mergeBase.mockResolvedValue(base as never);
    api.fileList.mockResolvedValue({ files: [{}, {}, {}], added: 12, deleted: 3 });
    await show();
    const flow = screen.getByRole('region', { name: 'Branches' });
    await waitFor(() => expect(flow).toHaveTextContent('2 commits3 files+12−3'));
    expect(api.mergeBase).toHaveBeenCalledWith(7, 'refs/remotes/origin/main', tip);
    expect(api.fileList).toHaveBeenCalledWith(7, { kind: 'compare', from: base, to: tip });
    fireEvent.click(within(flow).getByRole('button', { name: /Show commits/ }));
    expect(within(flow).getByRole('list', { name: 'Commits' })).toHaveTextContent(`${mid.slice(0, 7)}Add login${tip.slice(0, 7)}Polish login`);
  });
});
