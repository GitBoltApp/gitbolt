import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ errorMessage: (e: unknown) => String((e as { message: string }).message) }));
const { SearchPicker } = await import('./create/SearchPicker');
const { clearPickerCache, labelsSource, mapSource, peopleSource, STALE_MS } = await import('./pickerCache');
const { notifyForgeAccountsChanged } = await import('./accountsBus');

interface L { name: string }
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(300); });
const names = () => screen.queryAllByRole('option').map((o) => o.textContent);

beforeEach(() => { vi.useFakeTimers(); clearPickerCache(); });
afterEach(() => { vi.useRealTimers(); });

function mount(fetch: (q: string) => Promise<L[]>, src: 'people' | 'labels' = 'people', limit = 300) {
  const source = src === 'people' ? peopleSource(1, 'origin', fetch) : labelsSource(1, 'origin', limit, fetch);
  const m = mapSource(source, (l: L) => ({ key: l.name, label: l.name, value: l.name }));
  return render(<SearchPicker popover label="Labels" chips={[]} onRemove={vi.fn()} search={m.search} peek={m.peek} onPick={vi.fn()} />);
}

describe('picker cache', () => {
  it('a second open makes no new request within 5 minutes and shows results at once', async () => {
    const fetch = vi.fn(async () => [{ name: 'ann' }]);
    const a = mount(fetch);
    await flush();
    expect(names()).toEqual(['ann']);
    a.unmount();
    mount(fetch);
    expect(names()).toEqual(['ann']);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('after 5 minutes shows the cached results, then revalidates in place', async () => {
    let n = 0;
    const fetch = vi.fn(async () => [{ name: `v${++n}` }]);
    const a = mount(fetch);
    await flush();
    a.unmount();
    vi.setSystemTime(Date.now() + STALE_MS + 1000);
    mount(fetch);
    expect(names()).toEqual(['v1']);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(names()).toEqual(['v2']);
  });

  it('labels filter locally with no request per keystroke', async () => {
    const fetch = vi.fn(async () => [{ name: 'bug' }, { name: 'build' }, { name: 'docs' }]);
    mount(fetch, 'labels');
    await flush();
    const input = screen.getByLabelText('Labels');
    fireEvent.change(input, { target: { value: 'bu' } });
    await flush();
    expect(names()).toEqual(['bug', 'build']);
    fireEvent.change(input, { target: { value: 'bui' } });
    await flush();
    expect(names()).toEqual(['build']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('labels fall back to server search when the list reached the limit', async () => {
    const fetch = vi.fn(async (q: string) => [{ name: `${q}x` }, { name: `${q}y` }]);
    mount(fetch, 'labels', 2);
    await flush();
    fireEvent.change(screen.getByLabelText('Labels'), { target: { value: 'z' } });
    await flush();
    expect(fetch).toHaveBeenLastCalledWith('z');
    expect(names()).toEqual(['zx', 'zy']);
  });

  it('an account change clears the cache', async () => {
    const fetch = vi.fn(async () => [{ name: 'ann' }]);
    const a = mount(fetch);
    await flush();
    a.unmount();
    notifyForgeAccountsChanged();
    mount(fetch);
    expect(names()).toEqual([]);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('ignores an out-of-order response for an old query', async () => {
    const waits = new Map<string, (l: L[]) => void>();
    const fetch = vi.fn((q: string) => new Promise<L[]>((r) => waits.set(q, r)));
    mount(fetch);
    await flush();
    const input = screen.getByLabelText('Labels');
    fireEvent.change(input, { target: { value: 'a' } });
    await flush();
    fireEvent.change(input, { target: { value: 'ab' } });
    await flush();
    await act(async () => { waits.get('ab')?.([{ name: 'new' }]); });
    await act(async () => { waits.get('a')?.([{ name: 'old' }]); });
    expect(names()).toEqual(['new']);
  });
});
