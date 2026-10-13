import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ClearableInput } from './ClearableInput';

function Box() {
  const [v, setV] = useState('');
  return <ClearableInput aria-label="Filter" value={v} onChange={(e) => setV(e.target.value)} onClear={() => setV('')} />;
}

describe('ClearableInput', () => {
  afterEach(cleanup);
  it('shows the clear button only with text; it clears and leaves the focus in the box', () => {
    render(<Box />);
    const input = screen.getByRole('textbox', { name: 'Filter' });
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();
    fireEvent.change(input, { target: { value: 'abc' } });
    const clear = screen.getByRole('button', { name: 'Clear filter' });
    expect(clear.tabIndex).toBe(-1);
    fireEvent.click(clear);
    expect(input).toHaveValue('');
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();
  });
});
