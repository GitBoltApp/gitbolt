import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', () => ({ api: {}, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
const polling = vi.hoisted(() => ({ notifyForgeWrite: vi.fn() }));
vi.mock('../usePolling', () => polling);

const { forgeWrite, putDescription, putMr } = await import('./writes');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toastStore');
const { detailOf, mrOf, user } = await import('../testMrs');

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  useToast.getState().dismiss();
});

describe('forge writes from the MR/PR view (spec #4 §3.5, §6)', () => {
  it('a write that works asks the poller to poll at once', async () => {
    const out = await forgeWrite('t', "Couldn't approve !12", async (repo) => repo * 2);
    expect(out).toEqual({ value: 8 });
    expect(polling.notifyForgeWrite).toHaveBeenCalledWith('t');
  });

  it('a write that fails says why and changes nothing', async () => {
    patchForge('t', { kind: 'gitlab', list: null });
    const before = forgeOf('t');
    const out = await forgeWrite('t', "Couldn't merge !12", async () => { throw { message: 'gitlab.example.com: Branch cannot be merged' }; });
    expect(out).toBeNull();
    expect(useToast.getState().message).toBe("Couldn't merge !12: gitlab.example.com: Branch cannot be merged");
    expect(forgeOf('t')).toBe(before);
    expect(polling.notifyForgeWrite).not.toHaveBeenCalled();
  });

  it("puts the server's answer in the store, keeping the loaded review and description", () => {
    const review = { decision: 'approved' as const, approvals: 1, approvalsRequired: null, reviews: [{ user: user('Ada Lovelace'), state: 'approved' as const, submittedAt: null }] };
    patchForge('t', { details: { 12: { value: detailOf(mrOf(12, { review })), at: 1 } } });
    putMr('t', mrOf(12, { state: 'merged' }));
    const d = forgeOf('t').details[12]!.value;
    expect([d.mr.state, d.mr.review.approvals, d.description]).toEqual(['merged', 1, 'Adds the dev work.']);
    putDescription('t', 12, 'New text');
    expect(forgeOf('t').details[12]!.value.description).toBe('New text');
  });
});
