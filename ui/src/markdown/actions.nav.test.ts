import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { RowPayload } from '../api/gen/RowPayload';

vi.mock('../api/client', async (actual) => ({ ...(await actual<typeof import('../api/client')>()), api: { openUrl: vi.fn(async () => null) } }));

const { openLinkTarget } = await import('./actions');
const { historyOf, placeKey, useNavHistory } = await import('../nav/history');
const { activeTabWith, EMPTY_GRAPH } = await import('../app/testShell');
const { createRepoViewStore } = await import('../repo/store');
const { fakeServices } = await import('../repo/testServices');

const A = 'a'.repeat(40);
const row = (id: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: 'x', bodyFirstLine: '', authorName: 'Ada', authorEmail: 'ada@example.com', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null }) as RowPayload;

// The commit jump loads the menu env on use: load it once up front.
beforeAll(async () => { await import('../menu/menuEnv'); });
beforeEach(() => useNavHistory.setState({ byTab: {} }));

it('a SHA-link jump to a loaded commit is a navigation place (spec #5 §3.4); one to the forge is not', async () => {
  const store = activeTabWith(createRepoViewStore(1, '/t', { ...EMPTY_GRAPH, rows: [row(A)] }, fakeServices()));
  await openLinkTarget({ kind: 'forge', tabId: 't' }, { kind: 'commit', sha: A, webUrl: null });
  expect(historyOf('t').places.map(placeKey)).toEqual([`commit:${A}`]);
  expect(store.getState().selection).toMatchObject({ kind: 'commit', id: A });
  await openLinkTarget({ kind: 'forge', tabId: 't' }, { kind: 'commit', sha: 'f'.repeat(40), webUrl: 'https://gitlab.example.com/g/p/-/commit/fff' });
  expect(historyOf('t').places).toHaveLength(1);
});
