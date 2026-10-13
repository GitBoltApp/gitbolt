import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchUpdateOffer } from '../../api/gen/BranchUpdateOffer';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeProjectSettings } from '../../api/gen/ForgeProjectSettings';

const api = vi.hoisted(() => ({ forgeMerge: vi.fn(), forgeSetAutoMerge: vi.fn(), forgeCancelAutoMerge: vi.fn(), forgeProjectSettings: vi.fn(), forgeUpdateBranch: vi.fn(), mergeBase: vi.fn(), saveProfile: vi.fn(async () => {}) }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
vi.mock('../usePolling', () => ({ notifyForgeWrite: vi.fn() }));
const poll = vi.hoisted(() => ({ refreshMr: vi.fn(async () => {}) }));
vi.mock('../poll', () => poll);
const confirm = vi.hoisted(() => ({ confirmAction: vi.fn(async () => true) }));
vi.mock('../../ui/ConfirmDialog', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../ui/ConfirmDialog')>()), confirmAction: confirm.confirmAction }));

const { MergeBox } = await import('./MergeBox');
const { resetProjectSettings } = await import('./projectSettings');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toastStore');
const { useMenu } = await import('../../menu/menuStore');
const { detailOf, mrOf, user } = await import('../testMrs');
const { EMPTY_PROFILE, useAppState } = await import('../../app/state');
const { lentHandler } = await import('../../app/lent');
const { clearLocalBehind } = await import('./branchUpdate');

const mr = mrOf(12, { title: 'Dev work' });
const settings = (over: Partial<ForgeProjectSettings> = {}): ForgeProjectSettings => ({ mergeMethods: ['merge'], squash: 'defaultOn', deleteSourceBranch: true, ...over });
const show = (kind: 'gitlab' | 'github', d = detailOf(mr)) => render(<MergeBox tabId="t" kind={kind} mr={d.mr} detail={d} />);
const running = (over: Partial<ForgeMr> = {}) => ({ ...mr, pipeline: { status: 'running' as const, webUrl: null }, ...over });
/** The merge options have loaded (their switches take clicks). */
const loaded = () => waitFor(() => expect(screen.queryByText(/merge options/)).toBeNull());
const primary = () => document.querySelector<HTMLButtonElement>('.mr-merge-top .mr-merge-go')!;
const title = () => document.querySelector('.mr-merge-top .mr-merge-title')?.textContent;
const tone = () => document.querySelector('.mr-merge-dot')?.className;

beforeEach(() => {
  vi.clearAllMocks();
  resetProjectSettings();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', remote: 'origin', details: { 12: { value: detailOf(mr), at: 1 } } });
  useRuntime.setState({ tabs: { t: { repo: { id: 4, path: '/r' } } as never } });
  useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
  clearLocalBehind();
  api.mergeBase.mockResolvedValue(null);
  useToast.getState().dismiss();
  api.forgeProjectSettings.mockResolvedValue(settings());
  api.forgeMerge.mockResolvedValue(mrOf(12, { state: 'merged' }));
  api.forgeSetAutoMerge.mockImplementation(async () => running({ autoMerge: { enabledBy: user('Ada Lovelace'), method: null } }));
  api.forgeCancelAutoMerge.mockImplementation(async () => running());
});

describe('merging from the MR/PR view (spec #4 §2: forge options, disabled with the reason when blocked)', () => {
  it("GitLab: Delete source branch, then Squash commits, from the project's defaults; Merge arms, then merges with them and the head (the messages are GitLab's own)", async () => {
    show('gitlab');
    await loaded();
    expect(screen.getAllByRole('switch').map((s) => s.getAttribute('aria-labelledby') && document.getElementById(s.getAttribute('aria-labelledby')!)?.textContent)).toEqual(['Delete source branch', 'Squash commits']);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Squash commits' })).toBeChecked();
    const del = screen.getByRole('switch', { name: 'Delete source branch' });
    expect(del).toBeChecked();
    fireEvent.click(del);
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(useToast.getState().message).toBe('Merged !12 into main'));
    expect(confirm.confirmAction).toHaveBeenCalledWith(expect.objectContaining({ arm: 'Click again to merge !12 into main', confirmLabel: 'Merge' }));
    expect(api.forgeMerge).toHaveBeenCalledWith(4, 12, { method: null, squash: true, deleteSourceBranch: false, expectedSha: mr.headSha });
    expect(forgeOf('t').details[12]?.value.mr.state).toBe('merged');
  });

  it("the method is the button's tooltip, not a line of its own", async () => {
    api.forgeProjectSettings.mockResolvedValue(settings({ mergeMethods: ['fastForward'] }));
    show('gitlab');
    await loaded();
    expect(screen.queryByText(/Merge method/)).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Merge' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Merges by fast-forwarding');
  });

  it('GitLab: a project that always squashes locks it on; one that never does hides it', async () => {
    api.forgeProjectSettings.mockResolvedValue(settings({ squash: 'always' }));
    const { unmount } = show('gitlab');
    const squash = await screen.findByRole('switch', { name: 'Squash commits' });
    await waitFor(() => expect(squash).toBeDisabled());
    expect(squash).toBeChecked();
    unmount();
    resetProjectSettings();
    api.forgeProjectSettings.mockResolvedValue(settings({ squash: 'never' }));
    show('gitlab');
    await loaded();
    expect(screen.queryByRole('switch', { name: 'Squash commits' })).toBeNull();
  });

  it("GitHub: the method is chosen in the button's dropdown among the repository's; deleting the branch is its own setting", async () => {
    api.forgeProjectSettings.mockResolvedValue(settings({ mergeMethods: ['merge', 'squash'], squash: 'defaultOff', deleteSourceBranch: true }));
    show('github');
    fireEvent.click(await screen.findByRole('button', { name: 'Merge method' }));
    const squash = useMenu.getState().rows?.find((r) => r.kind === 'action' && r.label === 'Squash and merge');
    act(() => { if (squash?.kind === 'action') squash.run(); });
    expect(screen.getByText('GitHub deletes the branch after merging (repository setting)')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Squash commits' })).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Merge' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Squashes the commits into one, then merges');
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(api.forgeMerge).toHaveBeenCalledWith(4, 12, { method: 'squash', squash: null, deleteSourceBranch: null, expectedSha: mr.headSha }));
  });


  it('is disabled with the reason while blocked or checking', async () => {
    const { unmount } = show('gitlab', detailOf(mr, { mergeStatus: { kind: 'blocked', reason: 'It needs approval first' } }));
    expect(await screen.findByText('It needs approval first')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
    unmount();
    show('github', detailOf(mr, { mergeStatus: { kind: 'checking' } }));
    expect(await screen.findByText('GitHub is still checking whether it can merge')).toBeTruthy();
  });

  it('a refused merge changes nothing and says why', async () => {
    api.forgeMerge.mockRejectedValueOnce({ message: '!12 changed since it was loaded: refresh and try again' });
    show('gitlab');
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't merge !12: !12 changed since it was loaded: refresh and try again"));
    expect(forgeOf('t').details[12]?.value.mr.state).toBe('open');
    expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled();
  });

  it('a declined confirm merges nothing; a merged MR has no merge box', async () => {
    confirm.confirmAction.mockResolvedValueOnce(false);
    const { unmount } = show('gitlab');
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(confirm.confirmAction).toHaveBeenCalled());
    expect(api.forgeMerge).not.toHaveBeenCalled();
    unmount();
    const { container } = show('gitlab', detailOf(mrOf(12, { state: 'merged' })));
    expect(container).toBeEmptyDOMElement();
  });

  it('does nothing while the merge options are loading', async () => {
    api.forgeProjectSettings.mockReturnValue(new Promise(() => {}));
    show('gitlab');
    expect(screen.getByText('Loading merge options…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(confirm.confirmAction).not.toHaveBeenCalled();
    expect(api.forgeMerge).not.toHaveBeenCalled();
  });

  // --- 4B final fix ---
  it("says why the merge options couldn't load, and asks again after the next poll", async () => {
    api.forgeProjectSettings.mockRejectedValueOnce({ message: 'gitlab.example.com refused: insufficient_scope' });
    show('gitlab');
    expect(await screen.findByText("Couldn't load merge options: gitlab.example.com refused: insufficient_scope")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
    act(() => patchForge('t', { updatedAt: 2 }));
    await loaded();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled();
    expect(api.forgeProjectSettings).toHaveBeenCalledTimes(2);
  });

  it('keeps the option rows and the reason row in the layout while loading and once clear', async () => {
    let done!: (s: ForgeProjectSettings) => void;
    api.forgeProjectSettings.mockReturnValue(new Promise((r) => (done = r)));
    const { container } = show('gitlab');
    const rows = () => [...container.querySelectorAll('.mr-merge-row, .mr-merge-reason')].map((e) => (e as HTMLElement).style.visibility || 'visible');
    expect(rows()).toEqual(['visible', 'hidden', 'hidden']);
    await act(async () => done(settings()));
    expect(rows()).toEqual(['visible', 'visible', 'visible']);
  });

  it('GitHub: one allowed method has no dropdown', async () => {
    api.forgeProjectSettings.mockResolvedValue(settings({ mergeMethods: ['squash'] }));
    show('github');
    await loaded();
    expect(screen.queryByRole('button', { name: 'Merge method' })).toBeNull();
  });
  // --- end 4B final fix ---

  it('the status row: titles and tones for ready, blocked, scheduled, conflicts and checking', async () => {
    const ready = show('gitlab', detailOf({ ...mr, pipeline: { status: 'success', webUrl: null } }, { mergeStatus: { kind: 'mergeable' } }));
    await loaded();
    expect(title()).toBe('Ready to merge');
    expect(tone()).toContain('ready');
    expect(screen.getByRole('note')).toHaveTextContent('Pipeline passed');
    expect(primary()).toHaveClass('merge');
    ready.unmount();
    const blocked = show('gitlab', detailOf(mr, { mergeStatus: { kind: 'blocked', reason: 'It needs approval first' } }));
    await screen.findByText('It needs approval first');
    expect(title()).toBe('Merge is blocked');
    expect(tone()).toContain('wait');
    blocked.unmount();
    const sched = show('gitlab', detailOf(mr, { mergeStatus: { kind: 'blocked', reason: "It can't merge before its scheduled time" } }));
    await screen.findByText("It can't merge before its scheduled time");
    expect(title()).toBe('Merge is scheduled');
    sched.unmount();
    const bad = show('gitlab', detailOf(mr, { mergeStatus: { kind: 'blocked', reason: 'It has conflicts: rebase first' } }));
    await screen.findByText('It has conflicts: rebase first');
    expect(tone()).toContain('bad');
    bad.unmount();
    show('github', detailOf(mr, { mergeStatus: { kind: 'checking' } }));
    expect(title()).toBe('Checking…');
  });

  it('the icon sits on the title line: both in the first row of the status grid', () => {
    show('gitlab');
    const top = document.querySelector('.mr-merge-top')!;
    expect([...top.children].map((c) => c.className.split(' ')[0])).toEqual(['mr-merge-dot', 'mr-merge-title', 'mr-merge-reason', 'mr-merge-act']);
  });

  it('a failed pipeline says so, as the forge does', async () => {
    const failed = { ...mr, pipeline: { status: 'failed' as const, webUrl: null } };
    const { unmount } = show('gitlab', detailOf(failed, { mergeStatus: { kind: 'blocked', reason: 'The pipeline must succeed first' } }));
    expect(await screen.findByText('The pipeline failed')).toBeTruthy();
    expect(tone()).toContain('bad');
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
    unmount();
    show('github', detailOf(failed, { mergeStatus: { kind: 'blocked', reason: 'Branch protection blocks it: required reviews or checks' } }));
    expect(await screen.findByText('Some checks were not successful')).toBeTruthy();
  });
});

describe('auto-merge (merge when all checks pass)', () => {
  it('while the checks run, the button is Set to auto-merge: it arms, then sets it with the options', async () => {
    show('gitlab', detailOf(running(), { mergeStatus: { kind: 'blocked', reason: 'The pipeline is still running' } }));
    await loaded();
    await waitFor(() => expect(screen.getByRole('note')).toHaveTextContent('Merge when all checks pass'));
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull();
    const set = screen.getByRole('button', { name: 'Set to auto-merge' });
    fireEvent.mouseEnter(set);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Merges with a merge commit once all checks pass');
    fireEvent.click(set);
    await waitFor(() => expect(useToast.getState().message).toBe('!12 will merge when all checks pass'));
    expect(confirm.confirmAction).toHaveBeenCalledWith(expect.objectContaining({ arm: 'Click again to set !12 to auto-merge', confirmLabel: 'Set to auto-merge' }));
    expect(api.forgeSetAutoMerge).toHaveBeenCalledWith(4, 12, { method: null, squash: true, deleteSourceBranch: true, expectedSha: mr.headSha });
    expect(api.forgeMerge).not.toHaveBeenCalled();
    expect(forgeOf('t').details[12]?.value.mr.autoMerge?.enabledBy?.name).toBe('Ada Lovelace');
  });

  it('once set: who set it, a status line, and Cancel auto-merge (armed in place)', async () => {
    const set = running({ autoMerge: { enabledBy: user('Ada Lovelace'), method: null } });
    patchForge('t', { details: { 12: { value: detailOf(set), at: 1 } } });
    show('gitlab', detailOf(set));
    const t = document.querySelector('.mr-merge-title')!.cloneNode(true) as HTMLElement;
    t.querySelectorAll('[data-testid="avatar"]').forEach((a) => a.remove());
    expect(t.textContent?.replace(/\s+/g, ' ').trim()).toBe('Auto-merge set by Ada Lovelace');
    expect(screen.getByRole('note')).toHaveTextContent('Will merge when checks pass · Pipeline running');
    expect(document.querySelector('.mr-merge-title [data-testid="avatar"]'), 'their avatar').not.toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel auto-merge' }));
    await waitFor(() => expect(api.forgeCancelAutoMerge).toHaveBeenCalledWith(4, 12));
    expect(confirm.confirmAction).toHaveBeenCalledWith(expect.objectContaining({ arm: 'Click again to cancel auto-merge of !12' }));
    await waitFor(() => expect(useToast.getState().message).toBe('Auto-merge of !12 cancelled'));
    expect(forgeOf('t').details[12]?.value.mr.autoMerge).toBeNull();
  });

  it('a set auto-merge whose pipeline failed says it won\'t merge', () => {
    show('gitlab', detailOf({ ...mr, pipeline: { status: 'failed', webUrl: null }, autoMerge: { enabledBy: null, method: null } }));
    expect(screen.getByRole('note')).toHaveTextContent("The pipeline failed: it won't merge");
    expect(tone()).toContain('bad');
  });

  it('when the checks have passed it stays Merge; a conflict or a draft offers no auto-merge', async () => {
    const { unmount } = show('gitlab', detailOf({ ...mr, pipeline: { status: 'success', webUrl: null } }));
    await loaded();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled();
    unmount();
    show('gitlab', detailOf(running(), { mergeStatus: { kind: 'blocked', reason: 'It has conflicts: rebase or merge the target branch first' } }));
    await loaded();
    expect(screen.getByRole('button', { name: 'Set to auto-merge' })).toBeDisabled();
  });

  it('GitHub: the chosen method goes with it; a refusal says why', async () => {
    api.forgeProjectSettings.mockResolvedValue(settings({ mergeMethods: ['merge', 'squash'] }));
    api.forgeSetAutoMerge.mockRejectedValueOnce({ message: "Auto-merge isn't enabled for this repository" });
    show('github', detailOf(running(), { mergeStatus: { kind: 'blocked', reason: 'Branch protection blocks it: required reviews or checks' } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Merge method' }));
    const squash = useMenu.getState().rows?.find((r) => r.kind === 'action' && r.label === 'Squash and merge');
    act(() => { if (squash?.kind === 'action') squash.run(); });
    fireEvent.click(screen.getByRole('button', { name: 'Set to auto-merge' }));
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't set #12 to auto-merge: Auto-merge isn't enabled for this repository"));
    expect(api.forgeSetAutoMerge).toHaveBeenCalledWith(4, 12, expect.objectContaining({ method: 'squash' }));
  });

  it('GitLab merging it now: Merging…, no actions', () => {
    show('gitlab', detailOf(mrOf(12, { state: 'merging' }), { mergeStatus: { kind: 'blocked', reason: "It's being merged" } }));
    expect(title()).toBe('Merging…');
    expect(primary()).toBeDisabled();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe("the source branch's update: one split button, GitLab's Rebase, GitHub's Update branch", () => {
  type Over = { behind?: number | null; forgeBehind?: boolean; inProgress?: boolean };
  const offer = (kind: 'gitlab' | 'github', over: Over = {}): BranchUpdateOffer =>
    ({ behind: kind === 'gitlab' ? 3 : null, forgeBehind: true, kinds: kind === 'gitlab' ? ['rebase', 'rebaseSkipCi'] : ['merge', 'rebase'], inProgress: false, ...over });
  const behind = (kind: 'gitlab' | 'github', over: Over = {}) => detailOf(mr, { mergeStatus: { kind: 'blocked', reason: 'Rebase the source branch first' }, update: offer(kind, over) });
  const note = () => document.querySelector('.mr-merge-update-note');
  const row = () => document.querySelector('.mr-merge-update');
  /** The main part's shown label. */
  const mainLabel = () => row()!.querySelector('button')!.querySelector('span > span:not([aria-hidden])')?.textContent;
  const chevron = () => screen.getByRole('button', { name: 'Other ways to update the branch' });
  const menuLabels = () => (useMenu.getState().rows ?? []).map((r) => ('label' in r ? r.label : r.kind));
  const runRow = (i: number) => act(() => { const r = useMenu.getState().rows?.[i]; if (r?.kind === 'action') r.run(); });
  const saved = () => useAppState.getState().profile.repos['/r']?.branchUpdate;

  it('GitLab: offered with how far behind; Rebase is the main part, Rebase without pipeline in its menu; not offered when up to date', async () => {
    const { unmount } = show('gitlab', behind('gitlab'));
    await loaded();
    expect(note()).toHaveTextContent('The source branch is 3 commits behind main');
    expect(row()!.querySelectorAll('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Rebase' })).toHaveClass('primary', 'split');
    // Every way's label in one cell (all but one hidden): its width doesn't change with the default.
    expect(row()!.querySelector('button')!.textContent).toBe('RebaseRebase without pipelineRebasing…');
    fireEvent.click(chevron());
    expect(menuLabels()).toEqual(['Rebase without pipeline']);
    act(() => useMenu.getState().close());
    unmount();
    const second = show('gitlab', behind('gitlab', { behind: null }));
    expect(note()).toHaveTextContent('The source branch is behind main');
    second.unmount();
    show('gitlab', detailOf(mr, { update: offer('gitlab', { behind: null, forgeBehind: false }) }));
    await loaded();
    expect(row()).toBeNull();
  });

  it('GitHub: rebase first when the repository allows rebase merges, else merge; the other one in the menu, with its out-of-date line', async () => {
    api.forgeProjectSettings.mockResolvedValue(settings({ mergeMethods: ['merge', 'squash', 'rebase'] }));
    const { unmount } = show('github', behind('github'));
    await loaded();
    expect(note()).toHaveTextContent('This branch is out of date with main');
    expect(mainLabel()).toBe('Rebase onto main');
    fireEvent.click(chevron());
    expect(menuLabels()).toEqual(['Merge main in']);
    act(() => useMenu.getState().close());
    unmount();
    resetProjectSettings();
    api.forgeProjectSettings.mockResolvedValue(settings({ mergeMethods: ['merge', 'squash'] }));
    show('github', behind('github'));
    await loaded();
    expect(mainLabel()).toBe('Merge main in');
  });

  it('the way picked from the menu runs, and becomes the main part for the repository (kept in its settings)', async () => {
    api.forgeProjectSettings.mockResolvedValue(settings({ mergeMethods: ['merge', 'rebase'] }));
    api.forgeUpdateBranch.mockResolvedValue(mrOf(12));
    const { unmount } = show('github', behind('github'));
    await loaded();
    expect(mainLabel()).toBe('Rebase onto main');
    fireEvent.click(chevron());
    runRow(0);
    expect(api.forgeUpdateBranch).toHaveBeenCalledWith(4, 12, 'merge', mr.headSha);
    expect(saved()).toBe('merge');
    await waitFor(() => expect(useToast.getState().message).toBe('Merged main into #12'));
    expect(mainLabel()).toBe('Merge main in');
    unmount();
    // Shown again: the remembered way first.
    show('github', behind('github'));
    await loaded();
    expect(mainLabel()).toBe('Merge main in');
    fireEvent.click(chevron());
    expect(menuLabels()).toEqual(['Rebase onto main']);
  });

  it("a remembered way the forge doesn't offer falls back to the forge's default", async () => {
    useAppState.getState().updateRepo('/r', (r) => ({ ...r, branchUpdate: 'merge' }));
    show('gitlab', behind('gitlab'));
    await loaded();
    expect(mainLabel()).toBe('Rebase');
  });

  it('runs without arming: the busy label in the main part (as wide as before), the menu and Merge wait; then the MR is read again', async () => {
    let finish: (v: unknown) => void = () => {};
    api.forgeUpdateBranch.mockImplementation(() => new Promise((r) => { finish = r; }));
    show('gitlab', behind('gitlab'));
    await loaded();
    fireEvent.click(chevron());
    runRow(0);
    expect(confirm.confirmAction).not.toHaveBeenCalled();
    expect(api.forgeUpdateBranch).toHaveBeenCalledWith(4, 12, 'rebaseSkipCi', mr.headSha);
    expect(note()).toHaveTextContent('GitLab is rebasing the source branch onto main');
    const busy = screen.getByRole('button', { name: 'Rebasing…' });
    expect(busy).toBeDisabled();
    expect(busy.textContent).toBe('RebaseRebase without pipelineRebasing…');
    expect(chevron()).toBeDisabled();
    expect(primary()).toBeDisabled();
    await act(async () => finish(mrOf(12, { headSha: 'b'.repeat(40) })));
    await waitFor(() => expect(useToast.getState().message).toBe('Rebased !12 onto main'));
    expect(poll.refreshMr).toHaveBeenCalledWith('t', 12);
    expect(forgeOf('t').details[12]?.value.mr.headSha).toBe('b'.repeat(40));
    expect(screen.getByRole('button', { name: 'Rebase without pipeline' })).toBeEnabled();
  });

  it("a failure says the forge's reason in place, not in a toast, and it can be tried again", async () => {
    api.forgeUpdateBranch.mockRejectedValueOnce({ message: "GitLab couldn't rebase !12: Rebase failed. Please rebase locally" });
    show('gitlab', behind('gitlab'));
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Rebase' }));
    await waitFor(() => expect(note()).toHaveTextContent("GitLab couldn't rebase !12: Rebase failed. Please rebase locally"));
    expect(note()).toHaveClass('bad');
    expect(useToast.getState().message).toBeNull();
    expect(screen.getByRole('button', { name: 'Rebase' })).toBeEnabled();
  });

  it('a rebase GitLab is already running shows as running, with nothing to click', async () => {
    show('gitlab', behind('gitlab', { inProgress: true }));
    await loaded();
    expect(note()).toHaveTextContent('GitLab is rebasing the source branch onto main');
    expect(screen.getByRole('button', { name: 'Rebasing…' })).toBeDisabled();
    expect(chevron()).toBeDisabled();
  });

  it('Ctrl+Alt+U runs the main part: Rebase on GitLab, the remembered way on GitHub', async () => {
    api.forgeUpdateBranch.mockResolvedValue(mrOf(12));
    const { unmount } = show('gitlab', behind('gitlab'));
    await loaded();
    act(() => lentHandler('mr.updateBranch')?.());
    expect(api.forgeUpdateBranch).toHaveBeenLastCalledWith(4, 12, 'rebase', mr.headSha);
    await waitFor(() => expect(useToast.getState().message).toBe('Rebased !12 onto main'));
    unmount();
    useAppState.getState().updateRepo('/r', (r) => ({ ...r, branchUpdate: 'merge' }));
    show('github', behind('github'));
    await loaded();
    act(() => lentHandler('mr.updateBranch')?.());
    expect(api.forgeUpdateBranch).toHaveBeenLastCalledWith(4, 12, 'merge', mr.headSha);
  });

  it("GitHub: until the repository's merge settings load, the way isn't remembered and Ctrl+Alt+U waits", async () => {
    api.forgeProjectSettings.mockReturnValue(new Promise(() => {}));
    api.forgeUpdateBranch.mockResolvedValue(mrOf(12));
    show('github', behind('github'));
    expect(mainLabel()).toBe('Merge main in');
    expect(lentHandler('mr.updateBranch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Merge main in' }));
    expect(api.forgeUpdateBranch).toHaveBeenCalledWith(4, 12, 'merge', mr.headSha);
    expect(saved()).toBeUndefined();
    await waitFor(() => expect(useToast.getState().message).toBe('Merged main into #12'));
  });

  it("a failure's reason goes once the refreshed MR is no longer behind", async () => {
    api.forgeUpdateBranch.mockRejectedValueOnce({ message: "GitLab couldn't rebase !12: Rebase failed. Please rebase locally" });
    const { rerender } = show('gitlab', behind('gitlab'));
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Rebase' }));
    await waitFor(() => expect(note()).toHaveTextContent("GitLab couldn't rebase !12"));
    // A poll: still behind, the reason stays.
    const still = behind('gitlab');
    rerender(<MergeBox tabId="t" kind="gitlab" mr={still.mr} detail={still} />);
    expect(note()).toHaveTextContent("GitLab couldn't rebase !12");
    // Rebased elsewhere: the row goes with it.
    const done = detailOf(mr, { update: offer('gitlab', { behind: null, forgeBehind: false }) });
    rerender(<MergeBox tabId="t" kind="gitlab" mr={done.mr} detail={done} />);
    expect(row()).toBeNull();
  });

  describe('behind, from the commits when the repository has them (no forge request)', () => {
    const tip = 'c'.repeat(40);
    const withTarget = () => useRuntime.setState({ tabs: { t: { repo: { id: 4, path: '/r' }, sidebar: { remotes: [{ name: 'origin', branches: [{ name: 'main', target: tip }] }] } } as never } });
    const upToDate = () => detailOf(mr, { update: offer('github', { forgeBehind: false }) });

    it("offered when the target's tip isn't in the head's history, though GitHub doesn't say behind", async () => {
      withTarget();
      api.mergeBase.mockResolvedValue('d'.repeat(40));
      show('github', upToDate());
      await waitFor(() => expect(note()).toHaveTextContent('This branch is out of date with main'));
      expect(api.mergeBase).toHaveBeenCalledWith(4, tip, mr.headSha);
      expect(row()).not.toHaveAttribute('aria-hidden');
    });

    it("not offered when the head has the target's tip; its space kept (hidden) until the answer lands", async () => {
      withTarget();
      let answer: (v: string | null) => void = () => {};
      api.mergeBase.mockReturnValue(new Promise((r) => { answer = r; }));
      show('github', upToDate());
      await loaded();
      expect(row()).toHaveAttribute('aria-hidden', 'true');
      expect(row()).toHaveStyle({ visibility: 'hidden' });
      await act(async () => answer(tip));
      expect(row()).toBeNull();
    });

    it('an answer is kept: shown again, the view asks nothing and starts with it', async () => {
      withTarget();
      api.mergeBase.mockResolvedValue('d'.repeat(40));
      const { unmount } = show('github', upToDate());
      await waitFor(() => expect(note()).toHaveTextContent('out of date'));
      unmount();
      show('github', upToDate());
      expect(row()).not.toHaveAttribute('aria-hidden');
      await loaded();
      expect(api.mergeBase).toHaveBeenCalledTimes(1);
    });

    it("the forge's word when the commits aren't here (the head not fetched), asked again after a fetch", async () => {
      withTarget();
      const { unmount } = show('github', behind('github'));
      await waitFor(() => expect(api.mergeBase).toHaveBeenCalled());
      expect(row()).not.toBeNull();
      unmount();
      show('github', upToDate());
      await waitFor(() => expect(row()).toBeNull());
      expect(api.mergeBase).toHaveBeenCalledTimes(2);
      // A fetch brings the head (the sidebar reloads): asked again, and it's behind.
      api.mergeBase.mockResolvedValue('d'.repeat(40));
      act(() => withTarget());
      await waitFor(() => expect(note()).toHaveTextContent('This branch is out of date with main'));
      expect(api.mergeBase).toHaveBeenCalledTimes(3);
    });

    it('behind when the forge says so, though a stale remote-tracking target says not', async () => {
      withTarget();
      api.mergeBase.mockResolvedValue(tip);
      show('gitlab', behind('gitlab'));
      await waitFor(() => expect(api.mergeBase).toHaveBeenCalled());
      await loaded();
      expect(row()).not.toBeNull();
    });
  });
});
