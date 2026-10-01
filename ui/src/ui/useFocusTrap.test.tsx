import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useFocusTrap } from './useFocusTrap';

function Harness() {
  const [active, setActive] = useState(false);
  const { ref, onTab } = useFocusTrap<HTMLDivElement>(active);
  return (
    <div>
      <button type="button" onClick={() => setActive(true)}>Open</button>
      {active && (
        <div
          ref={ref}
          role="dialog"
          aria-label="Trap"
          onKeyDown={(e) => { if (e.key === 'Tab' && onTab(e)) e.preventDefault(); }}
        >
          <button type="button">First</button>
          <button type="button">Middle</button>
          <button type="button">Last</button>
          <button type="button" onClick={() => setActive(false)}>Close</button>
        </div>
      )}
    </div>
  );
}

describe('useFocusTrap', () => {
  it('focuses something inside once active, wraps Tab at the last item and Shift+Tab at the first', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    act(() => opener.click());
    const first = screen.getByRole('button', { name: 'First' });
    const last = screen.getByRole('button', { name: 'Close' });
    // Nothing had `autoFocus`: the trap focuses the first focusable itself.
    expect(document.activeElement).toBe(first);

    last.focus();
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false); // false: preventDefault() was called
    expect(document.activeElement).toBe(first);

    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it('leaves an ordinary Tab between two fields alone (no wrap, no preventDefault)', () => {
    render(<Harness />);
    act(() => screen.getByRole('button', { name: 'Open' }).click());
    const middle = screen.getByRole('button', { name: 'Middle' });
    middle.focus();
    // Not at an edge: `onTab` returns false, so the harness never calls `preventDefault`.
    expect(fireEvent.keyDown(middle, { key: 'Tab' })).toBe(true);
  });

  it('returns focus to the opener once the dialog closes', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    // jsdom's `.click()` doesn't focus the element the way a real click does, so focus it the
    // way a real user's click (or Enter on it) would have, before opening the dialog.
    opener.focus();
    act(() => opener.click());
    act(() => screen.getByRole('button', { name: 'Close' }).click());
    expect(document.activeElement).toBe(opener);
  });
});
