import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { preloadMarkdown } from './lazy';
import { MarkdownField } from './MarkdownField';

const ctx = { kind: 'forge', tabId: 't' } as const;

// The Markdown chunk loaded before any test (test-setup does it too, but quietly): the preview then
// renders in the click's own update, with nothing to wait for.
beforeAll(() => preloadMarkdown(), 60_000);

function Field({ initial = '', onKeyDown }: { initial?: string; onKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void }) {
  const [v, setV] = useState(initial);
  return <><MarkdownField label="Write a comment" value={v} onChange={setV} flavor="gitlab" context={ctx} onKeyDown={onKeyDown} /><button type="button" onClick={() => setV('## Changed')}>change</button></>;
}

describe('MarkdownField (spec #5 §3.2)', () => {
  it('previews the text rendered, and keeps the textarea (and its size) under the preview', () => {
    render(<Field initial={'## Hi\n\nthere'} />);
    const box = screen.getByRole('textbox', { name: 'Write a comment' });
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Hi' })).toBeInTheDocument();
    expect(box.isConnected).toBe(true);
    expect(screen.getByRole('tabpanel', { name: 'Write a comment preview' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Write' }));
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('## Hi\n\nthere');
  });

  it('says when there is nothing to preview', () => {
    render(<Field />);
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByText('Nothing to preview')).toBeInTheDocument();
  });

  it('Ctrl+Shift+P switches while the field has the focus', () => {
    render(<Field initial="text" />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Write a comment' }), { key: 'P', ctrlKey: true, shiftKey: true });
    const pane = screen.getByRole('tabpanel', { name: 'Write a comment preview' });
    fireEvent.keyDown(pane, { key: 'p', ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole('tabpanel')).toBeNull();
  });

  it('debounces the preview by 150 ms', async () => {
    vi.useFakeTimers();
    try {
      render(<Field initial="first" />);
      fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
      await act(async () => { await vi.runOnlyPendingTimersAsync(); });
      fireEvent.click(screen.getByRole('button', { name: 'change' }));
      expect(screen.getByRole('tabpanel')).toHaveTextContent('first');
      await act(async () => { vi.advanceTimersByTime(150); await vi.runOnlyPendingTimersAsync(); });
      expect(screen.getByRole('tabpanel')).toHaveTextContent('Changed');
    } finally { vi.useRealTimers(); }
  });

  it('Ctrl+Enter in Preview still sends, and Write gets the caret back', () => {
    // The focus moves in a 0 ms timer: fake timers run it, rather than polling for it.
    vi.useFakeTimers();
    try {
      const keys = vi.fn();
      render(<Field initial="hello world" onKeyDown={keys} />);
      const box = screen.getByRole('textbox', { name: 'Write a comment' }) as HTMLTextAreaElement;
      box.focus();
      box.setSelectionRange(5, 5);
      fireEvent.keyDown(box, { key: 'P', ctrlKey: true, shiftKey: true });
      act(() => { vi.runOnlyPendingTimers(); });
      expect(document.activeElement).toBe(screen.getByRole('tabpanel'));
      fireEvent.keyDown(screen.getByRole('tabpanel'), { key: 'Enter', ctrlKey: true });
      expect(keys).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter', ctrlKey: true }));
      fireEvent.keyDown(screen.getByRole('tabpanel'), { key: 'P', ctrlKey: true, shiftKey: true });
      act(() => { vi.runOnlyPendingTimers(); });
      expect(document.activeElement).toBe(box);
      expect([box.selectionStart, box.selectionEnd]).toEqual([5, 5]);
    } finally { vi.useRealTimers(); }
  });

  it('one editor box: the tabs and a toolbar in its header, the Markdown hint in its footer', () => {
    render(<MarkdownField label="Description" value="" onChange={() => {}} flavor="gitlab" context={ctx} toolbar={<button type="button">Template: none</button>} />);
    const box = screen.getByRole('textbox', { name: 'Description' }).closest('.md-field')!;
    const head = box.querySelector('.md-field-head')!;
    expect(head).toContainElement(screen.getByRole('tab', { name: 'Write' }));
    expect(head).toContainElement(screen.getByRole('button', { name: 'Template: none' }));
    expect(box.querySelector('.md-field-foot')).toHaveTextContent('Markdown supported · Ctrl+Shift+P to preview');
  });

  describe('emoji autocomplete', () => {
    const type = (initial: string) => {
      const keys = vi.fn();
      render(<Field onKeyDown={keys} />);
      const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Write a comment' });
      box.focus();
      fireEvent.change(box, { target: { value: initial, selectionStart: initial.length, selectionEnd: initial.length } });
      return { box, keys };
    };

    it(':thu then Enter inserts :thumbsup: and a space', async () => {
      const { box } = type('ok :thu');
      await screen.findByRole('listbox');
      expect(box).toHaveAttribute('aria-expanded', 'true');
      expect(box.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0].id);
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(box).toHaveValue('ok :thumbsup: ');
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('arrows move and Tab inserts the chosen one', async () => {
      const { box } = type(':thu');
      await screen.findByRole('listbox');
      const second = screen.getAllByRole('option')[1].textContent!.match(/:[^:]+:$/)![0];
      fireEvent.keyDown(box, { key: 'ArrowDown' });
      expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
      fireEvent.keyDown(box, { key: 'Tab' });
      expect(box.value).toBe(`${second} `);
    });

    it('a click inserts', async () => {
      const { box } = type(':rocke');
      fireEvent.click(await screen.findByRole('option', { name: /:rocket:/ }));
      expect(box).toHaveValue(':rocket: ');
    });

    it("Esc closes the popup only, and is the editor's again afterwards", async () => {
      const { box, keys } = type(':thu');
      await screen.findByRole('listbox');
      fireEvent.keyDown(box, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(keys).not.toHaveBeenCalled();
      fireEvent.keyDown(box, { key: 'Escape' });
      expect(keys).toHaveBeenCalledTimes(1);
    });

    it('Ctrl+Enter still reaches the editor with the popup open, and so does Enter without it', async () => {
      const { box, keys } = type(':thu');
      await screen.findByRole('listbox');
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
      expect(keys).toHaveBeenCalledTimes(1);
      fireEvent.change(box, { target: { value: 'plain', selectionStart: 5, selectionEnd: 5 } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(keys).toHaveBeenCalledTimes(2);
    });

    it('stays closed for a URL, a time and code', () => {
      const { box } = type('http://exa');
      expect(screen.queryByRole('listbox')).toBeNull();
      fireEvent.change(box, { target: { value: 'at 12:30', selectionStart: 8, selectionEnd: 8 } });
      fireEvent.change(box, { target: { value: '`:thu', selectionStart: 5, selectionEnd: 5 } });
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(box).toHaveAttribute('aria-expanded', 'false');
    });
  });
});
