import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './Switch';

function Toggle({ disabled = false, onChange = () => {} }: { disabled?: boolean; onChange?: (v: boolean) => void }) {
  const [on, setOn] = useState(false);
  return <Switch label="Squash commits" description="One commit on main" checked={on} disabled={disabled} onChange={(v) => { setOn(v); onChange(v); }} />;
}

describe('Switch', () => {
  it('is a named switch with its description, and aria-checked follows it', () => {
    render(<Toggle />);
    const sw = screen.getByRole('switch', { name: 'Squash commits' });
    expect(sw).toHaveAccessibleDescription('One commit on main');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('Space and Enter toggle it once per press (held keys repeat nothing); a click on its label does too', () => {
    const onChange = vi.fn();
    render(<Toggle onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Squash commits' });
    fireEvent.keyDown(sw, { key: ' ' });
    fireEvent.keyUp(sw, { key: ' ' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(sw, { key: 'Enter' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.keyDown(sw, { key: 'Enter', repeat: true });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByText('Squash commits'));
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(onChange.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('a disabled switch ignores keys and clicks', () => {
    const onChange = vi.fn();
    render(<Toggle disabled onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Squash commits' });
    expect(sw).toBeDisabled();
    fireEvent.keyDown(sw, { key: ' ' });
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });
});
