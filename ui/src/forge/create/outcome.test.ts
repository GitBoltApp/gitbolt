import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateMr } from '../../api/gen/CreateMr';

const api = vi.hoisted(() => ({ forgeCompleteCreate: vi.fn(), openUrl: vi.fn(async () => null) }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message: string }).message) }));
const { useToast } = await import('../../ui/toast');
const { partsText, retry, showCreated } = await import('./outcome');

const req: CreateMr = {
  source: { project: 'octo-org/widget', branch: 'feature' }, targetBranch: 'main', title: 'Add the widget', description: '', draft: false,
  reviewers: [2], assignees: [], labels: ['bug'], squash: null, deleteSourceBranch: null,
};
const c = { repoId: 7, remote: 'origin', kind: 'github' as const, req, number: 45, webUrl: 'https://github.com/octo-org/widget/pull/45' };
const toast = () => useToast.getState();

beforeEach(() => {
  vi.clearAllMocks();
  toast().dismiss();
});

describe('the create outcome (spec #4 §3.5)', () => {
  it('a clean create says so and links to it', () => {
    showCreated(c, []);
    expect(toast().message).toBe('Created #45');
    expect(toast().actions.map((a) => a.label)).toEqual(['Open #45']);
    toast().actions[0].run();
    expect(api.openUrl).toHaveBeenCalledWith(c.webUrl);
  });

  it('a partial failure is a sticky warning naming each part, with Retry', () => {
    showCreated(c, [{ part: 'reviewers', message: 'Reviews may only be requested from collaborators.' }, { part: 'labels', message: 'x' }]);
    expect(toast().message).toBe("PR #45 created; couldn't add reviewers: Reviews may only be requested from collaborators; couldn't add labels: x");
    expect([toast().sticky, toast().tone]).toEqual([true, 'warning']);
    expect(toast().actions.map((a) => a.label)).toEqual(['Retry', 'Open #45']);
  });

  it('Retry reruns only the failed parts and says what it added', async () => {
    api.forgeCompleteCreate.mockResolvedValue([]);
    await retry(c, ['reviewers', 'labels']);
    expect(api.forgeCompleteCreate).toHaveBeenCalledWith(7, 'origin', 45, req, ['reviewers', 'labels']);
    expect(toast().message).toBe('Added reviewers and labels to #45');
  });

  it('Retry says "Retrying…" until the outcome', async () => {
    let answer: (v: unknown) => void = () => {};
    api.forgeCompleteCreate.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    showCreated(c, [{ part: 'reviewers', message: 'x' }]);
    toast().actions[0].run();
    expect([toast().message, toast().sticky, toast().actions]).toEqual(['Retrying…', true, []]);
    answer([]);
    await vi.waitFor(() => expect(toast().message).toBe('Added reviewers to #45'));
  });

  it('a Retry that fails again keeps the warning with what still fails', async () => {
    api.forgeCompleteCreate.mockResolvedValueOnce([{ part: 'labels', message: 'y' }]);
    await retry(c, ['reviewers', 'labels']);
    expect(toast().message).toBe("PR #45 created; couldn't add labels: y");
    api.forgeCompleteCreate.mockRejectedValueOnce({ message: 'github.com rate limit reached: try again in 2 min' });
    await retry(c, ['reviewers']);
    expect(toast().message).toBe("PR #45 created; couldn't add reviewers: github.com rate limit reached: try again in 2 min");
  });

  it('lists parts like a sentence', () => {
    expect([partsText(['reviewers']), partsText(['reviewers', 'labels']), partsText(['reviewers', 'assignees', 'labels'])]).toEqual(['reviewers', 'reviewers and labels', 'reviewers, assignees and labels']);
  });
});
