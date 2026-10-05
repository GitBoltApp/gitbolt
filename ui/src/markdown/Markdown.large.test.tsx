import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';
import { clearParseCache } from './parse';
import { resetChunkStreams } from './parseAsync';

const ctx = { kind: 'forge', tabId: 't' } as const;
afterEach(() => { clearParseCache(); resetChunkStreams(); });

describe('a long document (ruling 21)', () => {
  it('shows its text, then renders chunk by chunk, with heading ids unique across chunks', async () => {
    // Fake timers drive the idle callbacks (jsdom has no requestIdleCallback; `whenIdle` uses a
    // timer): one step parses (no Worker in jsdom), then each step renders one more chunk, with
    // no wall-clock wait in between.
    vi.useFakeTimers();
    try {
      const text = Array.from({ length: 30 }, () => `## Same\n\n${'word '.repeat(400)}`).join('\n\n');
      const { container } = render(<Markdown flavor="github" context={ctx} text={text} />);
      const chunks = () => container.querySelectorAll('.md-chunk').length;
      expect(container.querySelector('.md-plain')).not.toBeNull();
      expect(chunks()).toBe(0);
      await act(() => vi.advanceTimersToNextTimerAsync()); // the parse
      expect(chunks()).toBe(1);
      for (let shown = 1; container.querySelector('.md-rendering'); shown++) {
        expect(chunks(), 'one more chunk per idle callback').toBe(shown);
        expect(shown, 'chunks').toBeLessThan(30);
        await act(() => vi.advanceTimersToNextTimerAsync());
      }
      expect(chunks()).toBeGreaterThan(1);
      const ids = [...container.querySelectorAll('h2')].map((h) => h.id);
      expect(ids).toHaveLength(30);
      expect(new Set(ids).size).toBe(30);
      expect(ids.slice(0, 2)).toEqual(['user-content-same', 'user-content-same-1']);
    } finally { vi.useRealTimers(); }
  });

  it('once the parse worker has died, a long body shows as written with "Too large to render"', async () => {
    class Crashing { onerror: ((e: Event) => void) | null = null; onmessage = null; postMessage() { setTimeout(() => this.onerror?.(new Event('error'))); } terminate() {} }
    vi.stubGlobal('Worker', Crashing);
    try {
      const text = `## Orphan\n\n${'word '.repeat(5_000)}`;
      const { container } = render(<Markdown flavor="github" context={ctx} text={text} />);
      await waitFor(() => expect(container).toHaveTextContent('Too large to render'));
      expect(container.querySelector('.md-plain')).toHaveTextContent('## Orphan');
      expect(container.querySelector('h2')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a re-render with the same text keeps the rendered chunks (a poll)', async () => {
    vi.useFakeTimers();
    try {
      const text = `## Kept\n\n${'word '.repeat(5_000)}`;
      const { container, rerender } = render(<Markdown flavor="github" context={ctx} text={text} />);
      await act(() => vi.advanceTimersToNextTimerAsync()); // the parse
      const h2 = container.querySelector('h2');
      expect(h2).not.toBeNull();
      rerender(<Markdown flavor="github" context={{ kind: 'forge', tabId: 't' }} text={text} />);
      expect(container.querySelector('h2')).toBe(h2);
    } finally { vi.useRealTimers(); }
  });
});
