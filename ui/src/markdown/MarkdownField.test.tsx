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
});
