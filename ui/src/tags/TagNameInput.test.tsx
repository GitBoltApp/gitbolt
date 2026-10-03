import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TagNameInput } from './TagNameInput';
import { tagNameError } from './tagName';

afterEach(cleanup);

describe('the inline tag input (spec #3 §3.9)', () => {
  it('lightweight: Enter creates; an invalid name says why and Enter does nothing', () => {
    const submit = vi.fn();
    render(<TagNameInput annotated={false} validate={tagNameError} onSubmit={submit} onCancel={() => {}} />);
    const input = screen.getByRole('textbox', { name: 'Tag name' });
    fireEvent.change(input, { target: { value: 'a..b' } });
    expect(screen.getByRole('alert')).toHaveTextContent("A tag name can't contain ..");
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'v1' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submit).toHaveBeenCalledWith('v1', null);
  });
  it('annotated: Enter moves to the message; Enter there creates, Shift+Enter is a new line; empty refuses', () => {
    const submit = vi.fn();
    render(<TagNameInput annotated validate={tagNameError} onSubmit={submit} onCancel={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Tag name' }), { target: { value: 'v2' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Tag name' }), { key: 'Enter' });
    const message = screen.getByRole('textbox', { name: 'Tag message' });
    fireEvent.keyDown(message, { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(message, { target: { value: 'Release two' } });
    fireEvent.keyDown(message, { key: 'Enter', shiftKey: true });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(message, { key: 'Enter' });
    expect(submit).toHaveBeenCalledWith('v2', 'Release two');
  });
  it('Esc cancels, from either box', () => {
    const cancel = vi.fn();
    render(<TagNameInput annotated validate={tagNameError} onSubmit={() => {}} onCancel={cancel} />);
    const input = screen.getByRole('textbox', { name: 'Tag name' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: 'v2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Tag message' }), { key: 'Escape' });
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
