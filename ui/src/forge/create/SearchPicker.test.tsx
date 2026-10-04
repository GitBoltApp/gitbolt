import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', () => ({ errorMessage: (e: unknown) => String((e as { message: string }).message) }));
const { SearchPicker } = await import('./SearchPicker');
import type { PickOption } from './SearchPicker';

const opt = (k: string): PickOption<string> => ({ key: k, label: k, value: k });

describe('SearchPicker (reviewers, assignees, labels)', () => {
  it('searches as you type, picks with the keyboard or a click, hides what is chosen, removes chips', async () => {
    const search = vi.fn(async (q: string) => [opt('grace'), opt(`${q}-1`), opt(`${q}-2`)]);
    const onPick = vi.fn();
    const onRemove = vi.fn();
    render(<SearchPicker label="Reviewers" chips={[{ key: 'grace', label: 'grace' }]} onRemove={onRemove} search={search} onPick={onPick} />);
    const input = screen.getByLabelText('Reviewers');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'ad' } });
    expect(await screen.findByRole('option', { name: 'ad-1' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'grace' })).toBeNull();
    expect(search).toHaveBeenCalledWith('ad');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('ad-2');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.click(await screen.findByRole('option', { name: 'x-1' }));
    expect(onPick).toHaveBeenLastCalledWith('x-1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove grace' }));
    expect(onRemove).toHaveBeenCalledWith('grace');
  });

  it("Enter mid-debounce never picks from the previous query's list", async () => {
    const search = vi.fn(async (q: string) => [opt(`${q}-1`)]);
    const onPick = vi.fn();
    render(<SearchPicker label="Labels" chips={[]} onRemove={vi.fn()} search={search} onPick={onPick} />);
    const input = screen.getByLabelText('Labels');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'a' } });
    expect(await screen.findByRole('option', { name: 'a-1' })).toBeTruthy();
    fireEvent.change(input, { target: { value: 'ab' } });
    expect(screen.queryByRole('option', { name: 'a-1' })).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    expect(await screen.findByRole('option', { name: 'ab-1' })).toBeTruthy();
  });

  it('a late answer to an older query never replaces the newer list', async () => {
    let answerA: (v: PickOption<string>[]) => void = () => {};
    const search = vi.fn((q: string) => (q === 'a' ? new Promise<PickOption<string>[]>((r) => { answerA = r; }) : Promise.resolve(q ? [opt(`${q}-new`)] : [])));
    render(<SearchPicker label="Labels" chips={[]} onRemove={vi.fn()} search={search} onPick={vi.fn()} />);
    const input = screen.getByLabelText('Labels');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'a' } });
    await waitFor(() => expect(search).toHaveBeenCalledWith('a'));
    fireEvent.change(input, { target: { value: 'ab' } });
    expect(await screen.findByRole('option', { name: 'ab-new' })).toBeTruthy();
    answerA([opt('a-old')]);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('option', { name: 'a-old' })).toBeNull();
    expect(screen.getByRole('option', { name: 'ab-new' })).toBeTruthy();
  });

  it('says why a search failed, and when nothing matches', async () => {
    const search = vi.fn(async (q: string): Promise<PickOption<string>[]> => {
      if (q === 'boom') throw { message: 'gitlab.example.com rate limit reached: try again in 2 min' };
      return [];
    });
    render(<SearchPicker label="Assignees" chips={[]} onRemove={vi.fn()} search={search} onPick={vi.fn()} />);
    const input = screen.getByLabelText('Assignees');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'zz' } });
    expect(await screen.findByText('No matches')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'boom' } });
    expect((await screen.findByRole('alert')).textContent).toBe('gitlab.example.com rate limit reached: try again in 2 min');
  });
});

describe('SearchPicker keys and ARIA', () => {
  it('Esc closes an open list and stops; a closed list lets Esc through; active descendant follows arrows', async () => {
    const search = vi.fn(async () => [opt('a1'), opt('a2')]);
    const outer = vi.fn();
    render(<div onKeyDown={outer}><SearchPicker label="Labels" chips={[]} onRemove={vi.fn()} search={search} onPick={vi.fn()} /></div>);
    const input = screen.getByLabelText('Labels');
    expect(input.getAttribute('role')).toBe('combobox');
    fireEvent.focus(input);
    const first = await screen.findByRole('option', { name: 'a1' });
    expect(input.getAttribute('aria-activedescendant')).toBe(first.id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'a2' }).id);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('option', { name: 'a1' })).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(outer).toHaveBeenCalledTimes(1);
  });
});
