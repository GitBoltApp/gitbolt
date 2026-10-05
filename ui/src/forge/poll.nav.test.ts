import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ api: {}, errorMessage: String }));

const { historyOf, placeKey, useNavHistory } = await import('../nav/history');
const { MR_FLYOUT } = await import('./mrStore');
const { openMrView } = await import('./poll');
const { flyoutOf, registerFlyout } = await import('../ui/flyout/flyout');

registerFlyout(MR_FLYOUT, () => null);
beforeEach(() => useNavHistory.setState({ byTab: {} }));

it("opening an MR/PR view adds a place; the list's arrow keys replace it", () => {
  openMrView('t', 12);
  openMrView('t', 5);
  expect(historyOf('t').places.map(placeKey)).toEqual(['mr:12', 'mr:5']);
  openMrView('t', 3, 'replace');
  expect(historyOf('t').places.map(placeKey)).toEqual(['mr:12', 'mr:3']);
  expect(flyoutOf('t')).toMatchObject({ kind: MR_FLYOUT, props: { number: 3 } });
});
