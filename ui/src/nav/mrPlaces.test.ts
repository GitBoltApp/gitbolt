import { beforeEach, describe, expect, it, vi } from 'vitest';

const poll = vi.hoisted(() => ({ openMrView: vi.fn(), loadMrDetail: vi.fn(async () => {}) }));
vi.mock('../forge/poll', () => poll);

await import('./mrPlaces');
const { historyOf, navBack, placeKey, recordPlace, useNavHistory } = await import('./history');
const { noteScroll, takePendingScroll } = await import('./scroll');
const { MR_FLYOUT, patchForge, useForge } = await import('../forge/mrStore');
const { closeFlyout, flyoutOf, openFlyout, registerFlyout } = await import('../ui/flyout/flyout');
const { useToast } = await import('../ui/toast');
const { detailOf, mrOf } = await import('../forge/testMrs');

registerFlyout(MR_FLYOUT, () => null);
const mr = (number: number) => ({ kind: 'mr' as const, number, scrollTop: 0 });
const known = (...ns: number[]) => Object.fromEntries(ns.map((n) => [n, { value: detailOf(mrOf(n)), at: 1 }]));

beforeEach(() => {
  vi.clearAllMocks();
  closeFlyout('t');
  useNavHistory.setState({ byTab: {} });
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', details: known(12, 5, 3, 7) });
  useToast.setState({ message: null });
  poll.openMrView.mockImplementation((tabId: string, n: number) => openFlyout(tabId, MR_FLYOUT, { number: n }));
});

describe('MR/PR places (spec #5 §3.4)', () => {
  it('Back to an MR/PR reopens its view, at the scroll it was left at', async () => {
    recordPlace('t', mr(12));
    noteScroll('t', 'mr', 'mr:12', 420);
    recordPlace('t', mr(5));
    expect(historyOf('t').places[0]).toEqual({ kind: 'mr', number: 12, scrollTop: 420 });
    await navBack('t');
    expect(poll.openMrView).toHaveBeenCalledWith('t', 12);
    expect(poll.loadMrDetail).toHaveBeenCalledWith('t', 12, 0);
    expect(takePendingScroll('t', 'mr', 'mr:12', null)).toMatchObject({ top: 420 });
  });

  it("an MR/PR that can't be loaded toasts, closes its view and is skipped", async () => {
    patchForge('t', { details: known(3, 7) });
    recordPlace('t', mr(3));
    recordPlace('t', mr(12));
    recordPlace('t', mr(7));
    await navBack('t');
    expect(useToast.getState().message).toBe("Couldn't load !12");
    expect(historyOf('t').places.map(placeKey)).toEqual(['mr:3', 'mr:7']);
    expect(flyoutOf('t')).toMatchObject({ props: { number: 3 } });
  });

  it('without a forge target, an MR/PR place is gone', async () => {
    recordPlace('t', mr(12));
    recordPlace('t', mr(5));
    patchForge('t', { kind: null });
    await navBack('t');
    expect(useToast.getState().message).toBe("Couldn't load !12");
    expect(poll.openMrView).not.toHaveBeenCalled();
    expect(historyOf('t').places.map(placeKey)).toEqual(['mr:5']);
  });
});
