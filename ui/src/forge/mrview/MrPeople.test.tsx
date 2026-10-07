import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';

const api = vi.hoisted(() => ({ forgeEditMr: vi.fn(), forgeSearchUsers: vi.fn(), forgePeopleLimits: vi.fn() }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
const polling = vi.hoisted(() => ({ notifyForgeWrite: vi.fn() }));
vi.mock('../usePolling', () => polling);

const { MrPeople } = await import('./MrPeople');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { clearPickerCache } = await import('../pickerCache');
const { resetPeopleLimits } = await import('../peopleLimits');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toastStore');
const { detailOf, mrOf, user } = await import('../testMrs');

const ada = { ...user('Ada Lovelace'), id: 7 };
const grace = { ...user('Grace Hopper'), id: 8 };
const hubot = { ...user('Hubot'), id: 5 };

function show(kind: ForgeKind, mr: ForgeMr, editLabels?: () => void) {
  const Live = () => {
    const d = useForge((s) => s.byTab.t?.details[mr.number]?.value ?? null);
    return <MrPeople tabId="t" kind={kind} mr={mr} detail={d} editLabels={editLabels} />;
  };
  return render(<Live />);
}

const detail = () => forgeOf('t').details[12]!.value;
const names = (row: 'Reviewers' | 'Assignees') => {
  const r = document.querySelector(`.people-card[data-row="${row.toLowerCase()}"]`)!;
  return [...r.querySelectorAll('.people-name')].map((n) => n.textContent);
};

async function pick(noun: string, box: string, who: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: `Add ${noun}` }));
  fireEvent.change(screen.getByRole('combobox', { name: box }), { target: { value: 'g' } });
  fireEvent.click(await screen.findByRole('option', { name: who }));
}

const mr = mrOf(12, { title: 'Dev work' });

beforeEach(() => {
  vi.clearAllMocks();
  clearPickerCache();
  resetPeopleLimits();
  api.forgePeopleLimits.mockResolvedValue({ maxReviewers: null, maxAssignees: null });
  useForge.setState({ byTab: {} });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  patchForge('t', { kind: 'gitlab', remote: 'origin', details: { 12: { value: detailOf(mr, { reviewers: [ada] }), at: 1 } } });
  api.forgeSearchUsers.mockResolvedValue([ada, grace]);
  api.forgeEditMr.mockResolvedValue(mr);
});

afterEach(() => useToast.getState().dismiss());

describe("the MR/PR view's reviewers and assignees", () => {
  it('adds an assignee at once from the cached people search, then sends the change', async () => {
    let answer!: (m: ForgeMr) => void;
    api.forgeEditMr.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    show('gitlab', mr);
    await pick('assignee', 'Assignees', /Grace Hopper/);
    // Optimistic: the chip is there before the forge answers.
    expect(names('Assignees')).toEqual(['Grace Hopper']);
    expect(api.forgeSearchUsers).toHaveBeenCalledWith(4, 'origin', 'g');
    await waitFor(() => expect(api.forgeEditMr).toHaveBeenCalledWith(4, 12, { title: null, description: null, labels: null, assignees: { add: [8], remove: [] } }));
    answer(mr);
    await waitFor(() => expect(polling.notifyForgeWrite).toHaveBeenCalledWith('t'));
    expect(detail().assignees.map((u) => u.id)).toEqual([8]);
  });

  it('removes a reviewer at once, without a confirm', async () => {
    show('gitlab', mr);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada Lovelace' }));
    expect(names('Reviewers')).toEqual([]);
    await waitFor(() => expect(api.forgeEditMr).toHaveBeenCalledWith(4, 12, { title: null, description: null, labels: null, reviewers: { add: [], remove: [ada.id] } }));
    await waitFor(() => expect(polling.notifyForgeWrite).toHaveBeenCalled());
  });

  it('puts things back when the forge refuses, and says why', async () => {
    api.forgeEditMr.mockRejectedValueOnce(new Error('gitlab.example.com refused: 403 Forbidden')).mockRejectedValueOnce(new Error('nope'));
    show('gitlab', mr);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada Lovelace' }));
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't remove Ada Lovelace from the reviewers of !12: gitlab.example.com refused: 403 Forbidden"));
    expect(names('Reviewers')).toEqual(['Ada Lovelace']);
    await pick('reviewer', 'Reviewers', /Grace Hopper/);
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't add Grace Hopper as a reviewer on !12: nope"));
    expect(names('Reviewers')).toEqual(['Ada Lovelace']);
    expect(polling.notifyForgeWrite).not.toHaveBeenCalled();
  });

  it('sends one change at a time, in order', async () => {
    const answers: Array<() => void> = [];
    api.forgeEditMr.mockImplementation(() => new Promise((r) => { answers.push(() => r(mr)); }));
    show('gitlab', mr);
    await pick('assignee', 'Assignees', /Grace Hopper/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada Lovelace' }));
    expect(names('Assignees')).toEqual(['Grace Hopper']);
    expect(names('Reviewers')).toEqual([]);
    expect(api.forgeEditMr).toHaveBeenCalledTimes(1);
    answers[0]!();
    await waitFor(() => expect(api.forgeEditMr).toHaveBeenCalledTimes(2));
    answers[1]!();
  });

  it("is reachable by keyboard: + Add, type, ↓, Enter", async () => {
    show('gitlab', mr);
    const add = screen.getByRole('button', { name: 'Add assignee' });
    add.focus();
    fireEvent.click(add);
    const box = screen.getByRole('combobox', { name: 'Assignees' });
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: 'gr' } });
    await screen.findByRole('option', { name: /Grace Hopper/ });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(names('Assignees')).toEqual(['Grace Hopper']);
  });

  it("on GitHub, a reviewer who already reviewed has no ×: GitHub keeps their review", () => {
    const gh = mrOf(12, { review: { decision: 'approved', approvals: 1, approvalsRequired: null, reviews: [{ user: hubot, state: 'approved', submittedAt: 1 }, { user: ada, state: 'pending', submittedAt: null }] } });
    patchForge('t', { kind: 'github', details: { 12: { value: detailOf(gh, { reviewers: [hubot, ada] }), at: 1 } } });
    show('github', gh);
    expect(names('Reviewers')).toEqual(['Hubot', 'Ada Lovelace']);
    expect(screen.queryByRole('button', { name: 'Remove Hubot' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Ada Lovelace' })).toBeEnabled();
  });

  // --- MR round 2 ---
  it('a project that allows one reviewer: + is a swap, and the pick replaces the reviewer in one write', async () => {
    api.forgePeopleLimits.mockResolvedValue({ maxReviewers: 1, maxAssignees: 1 });
    show('gitlab', mr);
    const swap = await screen.findByRole('button', { name: 'Replace reviewer' });
    expect(api.forgePeopleLimits).toHaveBeenCalledWith(4, 'origin');
    fireEvent.mouseEnter(swap);
    expect(screen.getByRole('tooltip')).toHaveTextContent('This project allows one reviewer');
    fireEvent.click(swap);
    fireEvent.change(screen.getByRole('combobox', { name: 'Reviewers' }), { target: { value: 'g' } });
    fireEvent.click(await screen.findByRole('option', { name: /Grace Hopper/ }));
    expect(names('Reviewers')).toEqual(['Grace Hopper']);
    await waitFor(() => expect(api.forgeEditMr).toHaveBeenCalledWith(4, 12, { title: null, description: null, labels: null, reviewers: { add: [grace.id], remove: [ada.id] } }));
    // Nobody assigned yet: a plain +.
    expect(screen.getByRole('button', { name: 'Add assignee' })).toBeTruthy();
  });

  it('GitHub: at 10 assignees + is off, and says why', async () => {
    api.forgePeopleLimits.mockResolvedValue({ maxReviewers: null, maxAssignees: 10 });
    const ten = Array.from({ length: 10 }, (_, i) => ({ ...user(`Person ${i}`), id: 100 + i }));
    patchForge('t', { kind: 'github', details: { 12: { value: detailOf(mr, { assignees: ten }), at: 1 } } });
    show('github', mr);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add assignee' })).toHaveAttribute('aria-disabled', 'true'));
    const add = screen.getByRole('button', { name: 'Add assignee' });
    fireEvent.mouseEnter(add);
    expect(screen.getByRole('tooltip')).toHaveTextContent('GitHub allows up to 10 assignees');
    fireEvent.click(add);
    expect(screen.queryByRole('combobox', { name: 'Assignees' })).toBeNull();
  });

  it('a write GitLab trimmed to one: the toast names who it kept, and the row swaps from then on', async () => {
    api.forgeEditMr.mockRejectedValueOnce({ message: 'GitLab kept only Ada Lovelace: this project allows one reviewer', detail: { kind: 'peopleLimit', role: 'reviewers' } });
    show('gitlab', mr);
    await pick('reviewer', 'Reviewers', /Grace Hopper/);
    await waitFor(() => expect(useToast.getState().message).toBe('GitLab kept only Ada Lovelace: this project allows one reviewer'));
    expect(names('Reviewers')).toEqual(['Ada Lovelace']);
    expect(await screen.findByRole('button', { name: 'Replace reviewer' })).toBeTruthy();
  });

  it("the Labels card's pencil opens label editing", () => {
    const edit = vi.fn();
    show('gitlab', mr, edit);
    const labels = document.querySelector('.people-card[data-row="labels"]')!;
    const pencil = within(labels as HTMLElement).getByRole('button', { name: 'Edit labels' });
    expect(pencil).toHaveClass('card-btn');
    fireEvent.mouseEnter(pencil);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Edit labels');
    fireEvent.click(pencil);
    expect(edit).toHaveBeenCalledTimes(1);
  });
  // --- end MR round 2 ---

  it('is read-only on a merged or closed MR, and while the detail loads', () => {
    const merged = mrOf(12, { state: 'merged' });
    const { unmount } = show('gitlab', merged);
    expect(screen.queryByRole('button', { name: 'Add reviewer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Ada Lovelace' })).toBeNull();
    unmount();
    patchForge('t', { details: {} });
    show('gitlab', mr);
    const card = screen.getByRole('group', { name: 'Reviewers, assignees and labels' });
    expect(within(card).getAllByText('Loading…')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Add reviewer' })).toBeNull();
  });
});
