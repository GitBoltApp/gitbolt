import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeProjectSettings } from '../../api/gen/ForgeProjectSettings';

const api = vi.hoisted(() => ({ forgeMerge: vi.fn(), forgeProjectSettings: vi.fn() }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
vi.mock('../usePolling', () => ({ notifyForgeWrite: vi.fn() }));
const confirm = vi.hoisted(() => ({ confirmAction: vi.fn(async () => true) }));
vi.mock('../../ui/ConfirmDialog', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../ui/ConfirmDialog')>()), confirmAction: confirm.confirmAction }));

const { MergeBox } = await import('./MergeBox');
const { resetProjectSettings } = await import('./projectSettings');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toast');
const { useMenu } = await import('../../menu/menuStore');
const { detailOf, mrOf } = await import('../testMrs');

const mr = mrOf(12);
const settings = (over: Partial<ForgeProjectSettings> = {}): ForgeProjectSettings => ({ mergeMethods: ['merge'], squash: 'defaultOn', deleteSourceBranch: true, ...over });
const show = (kind: 'gitlab' | 'github', d = detailOf(mr)) => render(<MergeBox tabId="t" kind={kind} mr={d.mr} detail={d} />);

beforeEach(() => {
  vi.clearAllMocks();
  resetProjectSettings();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', remote: 'origin', details: { 12: { value: detailOf(mr), at: 1 } } });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  useToast.getState().dismiss();
  api.forgeProjectSettings.mockResolvedValue(settings());
  api.forgeMerge.mockResolvedValue(mrOf(12, { state: 'merged' }));
});

describe('merging from the MR/PR view (spec #4 §2: forge options, disabled with the reason when blocked)', () => {
  it("GitLab: the project's method, squash and delete-source-branch defaults; Merge arms, then merges with them and the head", async () => {
    show('gitlab');
    expect(await screen.findByText('Merge method: Merge commit')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Squash commits' })).toBeChecked();
    const del = screen.getByRole('checkbox', { name: 'Delete the source branch' });
    expect(del).toBeChecked();
    fireEvent.click(del);
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(useToast.getState().message).toBe('Merged !12 into main'));
    expect(confirm.confirmAction).toHaveBeenCalledWith(expect.objectContaining({ arm: 'Click again to merge !12 into main', confirmLabel: 'Merge' }));
    expect(api.forgeMerge).toHaveBeenCalledWith(4, 12, { method: null, squash: true, deleteSourceBranch: false, expectedSha: mr.headSha });
    expect(forgeOf('t').details[12]?.value.mr.state).toBe('merged');
  });

  it('GitLab: a project that always squashes locks it on; one that never does hides it', async () => {
    api.forgeProjectSettings.mockResolvedValue(settings({ squash: 'always' }));
    const { unmount } = show('gitlab');
    const squash = await screen.findByRole('checkbox', { name: 'Squash commits' });
    expect(squash).toBeChecked();
    expect(squash).toBeDisabled();
    unmount();
    resetProjectSettings();
    api.forgeProjectSettings.mockResolvedValue(settings({ squash: 'never' }));
    show('gitlab');
    await screen.findByText('Merge method: Merge commit');
    expect(screen.queryByRole('checkbox', { name: 'Squash commits' })).toBeNull();
  });

  it("GitHub: the method is chosen among the repository's; deleting the branch is its own setting", async () => {
    api.forgeProjectSettings.mockResolvedValue(settings({ mergeMethods: ['merge', 'squash'], squash: 'defaultOff', deleteSourceBranch: true }));
    show('github');
    fireEvent.click(await screen.findByRole('button', { name: 'Merge method' }));
    const squash = useMenu.getState().rows?.find((r) => r.kind === 'action' && r.label === 'Squash and merge');
    act(() => { if (squash?.kind === 'action') squash.run(); });
    expect(screen.getByText('GitHub deletes the branch after merging (repository setting)')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
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
    await screen.findByText('Merge method: Merge commit');
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't merge !12: !12 changed since it was loaded: refresh and try again"));
    expect(forgeOf('t').details[12]?.value.mr.state).toBe('open');
    expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled();
  });

  it('a declined confirm merges nothing; a merged MR has no merge box', async () => {
    confirm.confirmAction.mockResolvedValueOnce(false);
    const { unmount } = show('gitlab');
    await screen.findByText('Merge method: Merge commit');
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
    expect(await screen.findByText('Merge method: Merge commit')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled();
    expect(api.forgeProjectSettings).toHaveBeenCalledTimes(2);
  });

  it('keeps the option rows and the reason row in the layout while loading and once clear', async () => {
    let done!: (s: ForgeProjectSettings) => void;
    api.forgeProjectSettings.mockReturnValue(new Promise((r) => (done = r)));
    const { container } = show('gitlab');
    const rows = () => [...container.querySelectorAll('.mr-merge-row, .mr-merge-reason')].map((e) => (e as HTMLElement).style.visibility || 'visible');
    expect(rows()).toEqual(['hidden', 'hidden', 'hidden', 'visible']);
    await act(async () => done(settings()));
    expect(rows()).toEqual(['visible', 'visible', 'visible', 'hidden']);
  });

  it('GitHub: one allowed method is shown as a line, like GitLab', async () => {
    api.forgeProjectSettings.mockResolvedValue(settings({ mergeMethods: ['squash'] }));
    show('github');
    expect(await screen.findByText('Merge method: Squash and merge')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Merge method' })).toBeNull();
  });
  // --- end 4B final fix ---

  it('shows a draft, conflict or pipeline reason as the disabled reason', async () => {
    show('gitlab', detailOf(mr, { mergeStatus: { kind: 'blocked', reason: 'The pipeline failed' } }));
    expect(await screen.findByText('The pipeline failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
  });
});
