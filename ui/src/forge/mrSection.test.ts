import { describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ forgeMrList: vi.fn() }));
vi.mock('../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));

const { mrSection, refreshMrList, withMrSection } = await import('./mrSection');
const { EMPTY_FORGE, forgeOf, patchForge } = await import('./mrStore');
const { useRuntime } = await import('../app/runtime');
const { mrOf, projectOf } = await import('./testMrs');

const list = (filter: 'all' | 'mine', mrs = [mrOf(12, { title: 'Dev work' })]) => ({ kind: 'gitlab' as const, remote: 'origin', project: projectOf(), filter, mrs, fetchedAt: 1, pollIntervalSecs: null });

describe('the MR/PR section (spec #4 §2 "MR/PR list")', () => {
  it('exists only with a forge target, its rows named by reference and title', () => {
    expect(mrSection({ ...EMPTY_FORGE })).toBeNull();
    const s = mrSection({ ...EMPTY_FORGE, kind: 'gitlab', list: list('all') })!;
    expect([s.id, s.label, s.nests]).toEqual(['mrs', 'Merge requests', false]);
    expect(s.items.map((i) => [i.key, i.name])).toEqual([['mr:12', '!12 Dev work']]);
    expect(mrSection({ ...EMPTY_FORGE, kind: 'github', list: list('all') })!.label).toBe('Pull requests');
  });

  it('says why it is empty', () => {
    expect(mrSection({ ...EMPTY_FORGE, kind: 'gitlab' })!.empty).toBe('Loading…');
    expect(mrSection({ ...EMPTY_FORGE, kind: 'gitlab', error: 'boom' })!.empty).toBe("Couldn't load: boom");
    expect(mrSection({ ...EMPTY_FORGE, kind: 'gitlab', list: list('all', []) })!.empty).toBe('No open merge requests');
    expect(mrSection({ ...EMPTY_FORGE, kind: 'github', list: list('all', []) })!.empty).toBe('No open pull requests');
    expect(mrSection({ ...EMPTY_FORGE, kind: 'gitlab', filter: 'mine', list: list('mine', []) })!.empty).toBe('None of yours are open');
    expect(mrSection({ ...EMPTY_FORGE, kind: 'gitlab', filter: 'reviewRequested', list: { ...list('all', []), filter: 'reviewRequested' } })!.empty).toBe('No reviews requested from you');
  });

  it('goes after Remote', () => {
    const s = (id: string) => ({ id, kind: id, label: id, items: [], nests: false }) as never;
    const mrs = mrSection({ ...EMPTY_FORGE, kind: 'gitlab', list: list('all') });
    expect(withMrSection([s('local'), s('remote'), s('tags')], mrs).map((x) => x.id)).toEqual(['local', 'remote', 'mrs', 'tags']);
    expect(withMrSection([s('local')], null).map((x) => x.id)).toEqual(['local']);
  });

  it('a list that loads clears the last error', async () => {
    useRuntime.setState({ tabs: { e: { repo: { id: 4 } } as never } });
    patchForge('e', { kind: 'gitlab', filter: 'all', error: 'boom' });
    api.forgeMrList.mockResolvedValueOnce(list('all'));
    await refreshMrList('e');
    expect([forgeOf('e').error, forgeOf('e').list?.filter]).toEqual([null, 'all']);
  });

  it("keeps the answer for the filter that's chosen now", async () => {
    useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
    patchForge('t', { kind: 'gitlab', filter: 'mine' });
    let answer: (v: unknown) => void = () => {};
    api.forgeMrList.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const late = refreshMrList('t');
    patchForge('t', { filter: 'all' });
    answer(list('mine'));
    await late;
    expect(forgeOf('t').list).toBeNull();
    expect(api.forgeMrList).toHaveBeenCalledWith(4, 'mine');
  });
});
