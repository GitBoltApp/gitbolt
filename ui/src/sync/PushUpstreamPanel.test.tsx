import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { armClock, press, pressEnter } from '../ui/arm/armTesting';
import { askPushTarget, branchWidth, PushUpstreamPanel } from './PushUpstreamPanel';

describe('the push-upstream panel (spec #2 §12.3, UX round 3)', () => {
  let clock: ReturnType<typeof armClock>;
  beforeEach(() => { clock = armClock(); });
  afterEach(() => clock.restore());

  it('the branch field sizes to its name: wider for a longer one (the CSS bounds it from 220px to the panel)', () => {
    expect(branchWidth('feature/new')).toBe('14ch');
    expect(branchWidth('')).toBe('4ch');
    render(<PushUpstreamPanel />);
    act(() => { void askPushTarget('feature/new', ['origin']); });
    const field = screen.getByRole('textbox', { name: 'Branch' });
    expect(field.style.width).toBe('14ch');
    fireEvent.change(field, { target: { value: 'feature/a-much-longer-branch-name-than-before' } });
    expect(field.style.width).toBe(branchWidth('feature/a-much-longer-branch-name-than-before'));
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
  });

  it('one row and a right-aligned [Cancel] [Push]; Push is focused, Track it ticked; Push answers the target and the tick', async () => {
    render(<PushUpstreamPanel />);
    let p!: ReturnType<typeof askPushTarget>;
    act(() => { p = askPushTarget('feature/new', ['up', 'origin']); });
    const panel = screen.getByRole('dialog', { name: 'Push feature/new to a remote' });
    expect(panel).toHaveTextContent('Push feature/new to');
    expect(panel).not.toHaveTextContent('and track it?');
    expect([...panel.querySelectorAll('.modal-actions button')].map((b) => b.textContent)).toEqual(['Cancel', 'Push']);
    const push = screen.getByRole('button', { name: 'Push' });
    expect(push).toHaveFocus();
    const track = screen.getByRole('checkbox', { name: 'Track it' });
    expect(track).toBeChecked();
    fireEvent.click(track);
    // The press that opened it (within the settle) never pushes.
    press(push);
    expect(screen.queryByRole('dialog')).not.toBeNull();
    clock.settle();
    press(push);
    await expect(p).resolves.toEqual({ target: { remote: 'origin', branch: 'feature/new' }, track: false });
  });

  it('Enter in the field pushes; Esc and a press outside cancel', async () => {
    render(<><PushUpstreamPanel /><p>outside</p></>);
    let p!: ReturnType<typeof askPushTarget>;
    act(() => { p = askPushTarget('main', ['origin']); });
    clock.settle();
    // Enter in the field: the form's implicit submit clicks Push (`detail` 0).
    pressEnter(screen.getByRole('button', { name: 'Push' }));
    await expect(p).resolves.toEqual({ target: { remote: 'origin', branch: 'main' }, track: true });

    act(() => { p = askPushTarget('main', ['origin']); });
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    await expect(p).resolves.toBeNull();

    act(() => { p = askPushTarget('main', ['origin']); });
    act(() => { fireEvent.pointerDown(screen.getByText('outside')); });
    await expect(p).resolves.toBeNull();
  });
});
