// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';
import { gbError } from './engine/errors';
import { reportToParent, whenGraphShown } from './frame';

function framed() {
  const postMessage = vi.fn();
  const win = { parent: { postMessage }, location: { origin: 'https://site.example' } };
  return { win: win as unknown as Window, postMessage };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('framed: once the graph shows, the parent hears "ready", on its own origin only', async () => {
  const { win, postMessage } = framed();
  reportToParent(win, Promise.resolve(), () => Promise.resolve());
  await settle();
  expect(postMessage).toHaveBeenCalledWith({ source: 'gitbolt-demo', type: 'ready' }, 'https://site.example');
});

test("a boot that fails reports why, the GbError's message", async () => {
  const { win, postMessage } = framed();
  const graph = vi.fn(() => Promise.resolve());
  reportToParent(win, Promise.reject(gbError('NotFound', "The demo's data is missing: orbital.gbdemo (404)")), graph);
  await settle();
  expect(graph).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledWith({ source: 'gitbolt-demo', type: 'failed', message: "The demo's data is missing: orbital.gbdemo (404)" }, 'https://site.example');
});

test('not framed (demo.html opened on its own): nothing is posted', async () => {
  const self = { location: { origin: 'https://site.example' }, postMessage: vi.fn() } as unknown as Window & { parent: Window };
  (self as { parent: Window }).parent = self;
  reportToParent(self, Promise.resolve(), () => Promise.resolve());
  await settle();
  expect(self.postMessage).not.toHaveBeenCalled();
});

test('whenGraphShown resolves once the commit graph is in the page', async () => {
  let shown = false;
  void whenGraphShown(document).then(() => { shown = true; });
  await settle();
  expect(shown).toBe(false);
  const grid = document.createElement('div');
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-label', 'Commit graph');
  document.body.append(grid);
  await settle();
  expect(shown).toBe(true);
  await expect(whenGraphShown(document)).resolves.toBeUndefined();
});
