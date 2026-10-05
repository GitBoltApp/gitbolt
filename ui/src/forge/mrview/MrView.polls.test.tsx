import { act, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';

const poll = vi.hoisted(() => ({ refreshMr: vi.fn(async () => {}), loadMrDetail: vi.fn(async () => {}), openMrView: vi.fn() }));
vi.mock('../poll', () => poll);
const api = vi.hoisted(() => ({ openUrl: vi.fn(async () => null), forgeImage: vi.fn(async () => ({ kind: 'found', mime: 'image/png', base64: 'iVBORw==' })), forgeProjectSettings: vi.fn(() => new Promise(() => {})) }));
vi.mock('../../api/client', () => ({ api, errorMessage: String }));
vi.mock('./openNote', () => ({ openNoteFile: vi.fn(async () => {}) }));
// Spies on the parse and the render, the real ones underneath.
vi.mock('../../markdown/parse', async (orig) => {
  const m = await orig<typeof import('../../markdown/parse')>();
  return { ...m, parseMarkdown: vi.fn(m.parseMarkdown) };
});
vi.mock('../../markdown/render', async (orig) => {
  const m = await orig<typeof import('../../markdown/render')>();
  return { ...m, renderTree: vi.fn(m.renderTree) };
});

const { MrView } = await import('./MrView');
const { patchForge, useForge } = await import('../mrStore');
const { detailOf, mrOf, user } = await import('../testMrs');
const { useRuntime } = await import('../../app/runtime');
const { parseMarkdown, clearParseCache } = await import('../../markdown/parse');
const { renderTree } = await import('../../markdown/render');

const grace = user('Grace Hopper');
const detail = detailOf(mrOf(12), { description: 'The **description**' });
const threads: ForgeDiscussion[] = Array.from({ length: 150 }, (_, i) => ({
  id: `d${i}`, resolvable: false, resolved: false,
  notes: [{ id: String(1000 + i), author: grace, body: `Comment **${i}** with \`code\``, createdAt: 1_791_100_000 + i, system: false, position: null }],
}));

beforeAll(async () => { await import('../../markdown/Markdown'); });

beforeEach(() => {
  vi.clearAllMocks();
  clearParseCache();
  useForge.setState({ byTab: {} });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  patchForge('t', { kind: 'gitlab', remote: 'origin', details: { 12: { value: detail, at: 1 } }, discussions: { 12: threads } });
});
// A test that timed out mid-way never reaches its `finally`: the next one starts on real timers.
afterEach(() => vi.useRealTimers());

describe('the MR/PR view under polls (more bodies than the parse cache holds)', () => {
  it('a poll tick that changes nothing in the MR re-parses and re-renders no body', async () => {
    // Fake timers drive the idle callbacks (jsdom has no requestIdleCallback: `whenIdle` uses a
    // timer), so no wall-clock wait.
    vi.useFakeTimers();
    try {
      const { container } = render(<MrView tabId="t" props={{ number: 12 }} close={() => {}} />);
      const rendered = () => container.querySelectorAll('.mr-note-body strong').length;
      // Every body rendered: the first ones at once, the rest a few per idle callback.
      for (let step = 0; rendered() < 150; step++) {
        expect(step, 'idle steps').toBeLessThan(60);
        await act(() => vi.advanceTimersToNextTimerAsync());
      }
      const parses = vi.mocked(parseMarkdown).mock.calls.length;
      const renders = vi.mocked(renderTree).mock.calls.length;
      expect(parses).toBeGreaterThanOrEqual(150);
      for (let tick = 1; tick <= 3; tick++) act(() => { patchForge('t', { updatedAt: Date.now() + tick, error: null, failures: 0 }); });
      // A refresh that re-renders the view with the same MR (its load time changed) parses nothing either.
      act(() => { patchForge('t', { details: { 12: { value: detail, at: 2 } } }); });
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(vi.mocked(parseMarkdown).mock.calls.length).toBe(parses);
      expect(vi.mocked(renderTree).mock.calls.length).toBe(renders);
    } finally { vi.useRealTimers(); }
    // 150 Markdown bodies rendered step by step: a few seconds alone, many more on a loaded
    // machine (the full suite's parallel workers). It waits on no clock, so a longer budget
    // can't hide a hang: the idle-steps bound above fails first.
  }, 90_000);

  it('renders the first bodies in the first paint and the rest when idle', () => {
    const { container } = render(<MrView tabId="t" props={{ number: 12 }} close={() => {}} />);
    const now = container.querySelectorAll('.mr-note-body strong').length;
    expect(now).toBeGreaterThan(0);
    expect(now).toBeLessThan(150);
    // The others hold their place as plain text meanwhile.
    expect(container.querySelectorAll('.mr-note-body .md-plain').length).toBe(150 - now);
  });
});
