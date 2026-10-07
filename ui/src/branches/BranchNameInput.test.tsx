import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BranchNameInput } from './BranchNameInput';

const nextFrame = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });

describe('BranchNameInput: leaving it empty cancels', () => {
  afterEach(() => vi.restoreAllMocks());
  const show = () => {
    const onCancel = vi.fn();
    render(<><BranchNameInput validate={() => null} onSubmit={vi.fn()} onCancel={onCancel} /><button type="button">elsewhere</button></>);
    return { onCancel, input: screen.getByRole('textbox', { name: 'Branch name' }) };
  };

  it('focus moving elsewhere in the app cancels it', async () => {
    const { onCancel } = show();
    act(() => screen.getByRole('button', { name: 'elsewhere' }).focus());
    await nextFrame();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('a blur the input gets straight back (the webview refocusing on a click in it) keeps it', async () => {
    const { onCancel, input } = show();
    act(() => { input.blur(); input.focus(); });
    await nextFrame();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('the window losing focus (switching apps) keeps it', async () => {
    const { onCancel, input } = show();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => input.blur());
    await nextFrame();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('a typed name stays when focus moves away', async () => {
    const { onCancel, input } = show();
    fireEvent.change(input, { target: { value: 'topic' } });
    act(() => screen.getByRole('button', { name: 'elsewhere' }).focus());
    await nextFrame();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
