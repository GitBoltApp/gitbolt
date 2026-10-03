import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PromptDialog, promptText } from './PromptDialog';

describe('promptText', () => {
  it('validates live, and answers the value and the checkbox', async () => {
    render(<PromptDialog />);
    let answer: Promise<{ value: string; checked: boolean } | null>;
    act(() => { answer = promptText({ title: 'Create branch', label: 'Name', confirmLabel: 'Create', validate: (v) => (v.includes(' ') ? 'No spaces' : null), checkbox: { label: 'Check out', initial: true } }); });
    const input = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(input, { target: { value: 'a b' } });
    expect(screen.getByRole('alert')).toHaveTextContent('No spaces');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'feature/x' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Check out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await expect(answer!).resolves.toEqual({ value: 'feature/x', checked: false });
  });
  it('Cancel answers null', async () => {
    render(<PromptDialog />);
    let answer: Promise<unknown>;
    act(() => { answer = promptText({ title: 'Rename', label: 'Name', initial: 'x', confirmLabel: 'Rename' }); });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(answer!).resolves.toBeNull();
  });
});

describe('promptText unchanged value', () => {
  it('shows no error for the untouched initial value, but still blocks it with requireChange', () => {
    render(<PromptDialog />);
    act(() => { void promptText({ title: 'Rename main', label: 'New name', initial: 'main', confirmLabel: 'Rename', requireChange: true, validate: (v) => (v === 'bad' ? 'Nope' : null) }); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'New name' }), { target: { value: 'bad' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Nope');
  });
});

describe('promptText reuse', () => {
  it('a new prompt with the same title starts from fresh form state', async () => {
    render(<PromptDialog />);
    act(() => { void promptText({ title: 'Create branch', label: 'Name', confirmLabel: 'Create' }); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'stale' } });
    act(() => { void promptText({ title: 'Create branch', label: 'Name', confirmLabel: 'Create' }); });
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });
});
