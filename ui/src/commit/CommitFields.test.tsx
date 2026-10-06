import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { WipDraft } from './draft';
import { CommitFields } from './CommitFields';

function Harness({ onSubmit = () => {}, initial = { summary: 'Fix x', description: 'one\ntwo' } }: { onSubmit?: () => void; initial?: WipDraft }) {
  const [v, setV] = useState(initial);
  return <CommitFields value={v} onChange={setV} onSubmit={onSubmit} />;
}

const summary = () => screen.getByRole('textbox', { name: 'Commit summary' }) as HTMLInputElement;
const description = () => screen.getByRole('textbox', { name: 'Commit description' }) as HTMLTextAreaElement;

describe('the commit fields (spec #2 §8.1)', () => {
  it('spell-checks the message (the bundled en-US dictionary)', () => {
    render(<Harness />);
    expect([summary().getAttribute('spellcheck'), description().getAttribute('spellcheck')]).toEqual(['true', 'true']);
  });

  it('Enter or ↓ in the summary moves to the description, caret at its start', () => {
    render(<Harness />);
    summary().focus();
    fireEvent.keyDown(summary(), { key: 'Enter' });
    expect(document.activeElement).toBe(description());
    expect(description().selectionStart).toBe(0);
    summary().focus();
    fireEvent.keyDown(summary(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(description());
  });

  it('↑ on the description’s first line moves back to the summary, caret at its end; not from line 2', () => {
    render(<Harness />);
    description().focus();
    description().setSelectionRange(5, 5); // on line 2
    fireEvent.keyDown(description(), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(description());
    description().setSelectionRange(1, 1);
    fireEvent.keyDown(description(), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(summary());
    expect(summary().selectionStart).toBe('Fix x'.length);
  });

  it('Ctrl+Enter submits from either box; Esc blurs and keeps the text', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.keyDown(summary(), { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(description(), { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    description().focus();
    fireEvent.keyDown(description(), { key: 'Escape' });
    expect(document.activeElement).not.toBe(description());
    expect(description().value).toBe('one\ntwo');
  });

  it('the counter shows past 60 and warns past 72; nothing is truncated', () => {
    render(<Harness initial={{ summary: 'x'.repeat(61), description: '' }} />);
    expect(screen.getByTestId('commit-counter')).toHaveTextContent('61');
    fireEvent.change(summary(), { target: { value: 'x'.repeat(90) } });
    expect(screen.getByTestId('commit-counter')).toHaveClass('warn');
    expect(summary().value).toHaveLength(90);
  });
});
