import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, confirmAction } from '../ConfirmDialog';
import { ArmLayer } from './ArmLayer';
import { placePopover } from './anchor';
import { setOrigin } from './origin';
import { armClock, press, pressEnter } from './armTesting';
import { arm, CLICK_SETTLE_MS, disarm, useArm } from './store';

const req = (n = 5) => ({ title: 'Discard all changes?', body: 'b', confirmLabel: 'Discard all', arm: `Click again to discard ${n} files`, danger: true });

/** A control whose click asks, then counts its runs. */
function Discard({ onRun, n = 5 }: { onRun: () => void; n?: number }) {
  return <button type="button" onClick={() => void confirmAction(req(n)).then((ok) => { if (ok) onRun(); })}>Discard all</button>;
}

// Visual only (aria-hidden): found by its class.
const overlay = () => document.querySelector<HTMLElement>('.arm-overlay');

describe('arm in place (spec §ui confirms)', () => {
  let rects: ReturnType<typeof vi.spyOn>;
  let clock: ReturnType<typeof armClock>;
  beforeEach(() => {
    clock = armClock();
    // jsdom does no layout: a rendered control reports one box, so it's "shown" and arms in place.
    rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
      return (this.isConnected ? [new DOMRect(10, 10, 24, 24)] : []) as unknown as DOMRectList;
    });
  });
  afterEach(() => {
    act(() => disarm());
    setOrigin(null);
    rects.mockRestore();
    clock.restore();
    vi.useRealTimers();
  });

  it('the first click arms the control, labelled with what a second click does; the second runs it', async () => {
    const run = vi.fn();
    render(<><Discard onRun={run} /><ArmLayer /><ConfirmDialog /></>);
    press(screen.getByRole('button', { name: 'Discard all' }));
    expect(overlay()).toHaveTextContent('Click again to discard 5 files');
    expect(overlay()).toHaveClass('tone-danger');
    // Visual only: the control keeps its name, described by the armed label.
    expect(overlay()).toHaveAttribute('aria-hidden', 'true');
    expect(overlay()).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('button', { name: 'Discard all' })).toHaveAccessibleDescription('Click again to discard 5 files');
    expect(screen.getByTestId('arm-live')).toHaveTextContent('Click again to discard 5 files');
    // Not a dialog: no popover.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(run).not.toHaveBeenCalled();
    clock.settle();
    press(overlay()!);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(overlay()).toBeNull();
    expect(screen.getByTestId('arm-live')).toHaveTextContent('');
  });

  it('a press anywhere else disarms, and so does Esc', async () => {
    const run = vi.fn();
    render(<><Discard onRun={run} /><p>elsewhere</p><ArmLayer /></>);
    press(screen.getByRole('button', { name: 'Discard all' }));
    expect(overlay()).not.toBeNull();
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(overlay()).toBeNull();

    press(screen.getByRole('button', { name: 'Discard all' }));
    expect(overlay()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(overlay()).toBeNull();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  it('Enter/Space on the focused control arms it, and again runs it', async () => {
    const run = vi.fn();
    render(<><Discard onRun={run} /><ArmLayer /></>);
    const btn = screen.getByRole('button', { name: 'Discard all' });
    btn.focus();
    pressEnter(btn);
    expect(overlay()).not.toBeNull();
    clock.settle();
    pressEnter(btn); // the second Enter: the control itself, not the overlay
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(overlay()).toBeNull();
  });

  it('a double click arms but never confirms: its second press lands within the click settle', async () => {
    const run = vi.fn();
    render(<><Discard onRun={run} /><ArmLayer /></>);
    const btn = screen.getByRole('button', { name: 'Discard all' });
    press(btn);
    // The second click of the double click lands on the overlay that just appeared under it.
    clock.advance(CLICK_SETTLE_MS - 80);
    fireEvent.pointerDown(overlay()!);
    fireEvent.click(overlay()!, { detail: 2 });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    expect(overlay()).not.toBeNull();
  });

  it('a quick deliberate second click confirms, even inside the OS double-click interval (detail 2)', async () => {
    const run = vi.fn();
    render(<><Discard onRun={run} /><ArmLayer /></>);
    press(screen.getByRole('button', { name: 'Discard all' }));
    clock.advance(CLICK_SETTLE_MS + 50);
    fireEvent.pointerDown(overlay()!);
    fireEvent.click(overlay()!, { detail: 2 });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it('a press that started before the arm, or within the settle, does not confirm', async () => {
    const run = vi.fn();
    render(<><Discard onRun={run} /><ArmLayer /></>);
    const btn = screen.getByRole('button', { name: 'Discard all' });
    const at = () => ({ el: btn, rect: null, via: 'pointer' as const, control: true, holds: 0 });
    // A late-arming question: the repeat click's press came before the arm, its click after.
    fireEvent.pointerDown(btn);
    act(() => { void confirmAction(req(), at()).then((ok) => { if (ok) run(); }); });
    clock.settle();
    fireEvent.click(overlay()!, { detail: 1 });
    // A fresh press, but too soon after arming (the settle guard; the arm doesn't expire).
    act(() => { void confirmAction(req(), at()).then((ok) => { if (ok) run(); }); });
    press(overlay()!);
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    expect(overlay()).not.toBeNull();
    clock.settle();
    press(overlay()!);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it('a held Enter arms but its repeats never confirm', async () => {
    const run = vi.fn();
    render(<><Discard onRun={run} /><ArmLayer /></>);
    const btn = screen.getByRole('button', { name: 'Discard all' });
    btn.focus();
    pressEnter(btn);
    clock.settle();
    const repeat = fireEvent.keyDown(btn, { key: 'Enter', repeat: true });
    // The repeat's own click is cancelled (no click in a browser); one dispatched anyway is ignored.
    expect(repeat).toBe(false);
    fireEvent.click(btn, { detail: 0 });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    expect(overlay()).not.toBeNull();
  });

  it('assistive technology activation (detail 0, no fresh key) confirms once settled, unless a key is held', async () => {
    const run = vi.fn();
    render(<><Discard onRun={run} /><ArmLayer /></>);
    const btn = screen.getByRole('button', { name: 'Discard all' });
    press(btn);
    fireEvent.click(btn, { detail: 0 }); // within the settle: nothing
    clock.settle();
    fireEvent.keyDown(btn, { key: ' ', repeat: true }); // a held key
    fireEvent.click(btn, { detail: 0 });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyUp(btn, { key: ' ' });
    fireEvent.click(btn, { detail: 0 });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it('only one control is armed app-wide: arming another disarms the first', async () => {
    const a = arm({ ...req(), arm: 'A', tone: 'danger' });
    const b = arm({ ...req(), arm: 'B', tone: 'positive' });
    await expect(a).resolves.toBe(false);
    expect(useArm.getState().armed?.req.arm).toBe('B');
    act(() => disarm());
    await expect(b).resolves.toBe(false);
  });

  it('disarms when its control goes away (the row it acted on is gone)', async () => {
    function Host({ shown }: { shown: boolean }) {
      return shown ? <button type="button">Discard</button> : null;
    }
    const { rerender } = render(<><Host shown /><ArmLayer /></>);
    const el = screen.getByRole('button', { name: 'Discard' });
    let a!: Promise<boolean>;
    act(() => { a = arm({ ...req(), tone: 'danger' }, { el, rect: null, via: 'pointer', control: true, holds: 0 }); });
    expect(overlay()).not.toBeNull();
    // Removed without a press (a watcher refresh): the frame check notices.
    rerender(<><Host shown={false} /><ArmLayer /></>);
    await expect(a).resolves.toBe(false);
    expect(overlay()).toBeNull();
  });

  it('has no timer: it stays armed until the user decides', () => {
    // A timer would be a setTimeout; the frame loop that follows the control stays real.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    render(<><Discard onRun={() => {}} /><ArmLayer /></>);
    press(screen.getByRole('button', { name: 'Discard all' }));
    act(() => { vi.advanceTimersByTime(10 * 60_000); });
    expect(overlay()).not.toBeNull();
  });

  it('an action started from the keyboard, with no control to arm, asks in a popover with key hints (board H)', async () => {
    render(<><ArmLayer /><ConfirmDialog /></>);
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    let a!: Promise<boolean>;
    act(() => { a = confirmAction(req()); });
    const pop = screen.getByRole('alertdialog', { name: 'Discard all changes?' });
    expect(pop).toHaveTextContent('go');
    expect(screen.getByRole('button', { name: 'Discard all' })).toHaveFocus();
    clock.settle();
    pressEnter(screen.getByRole('button', { name: 'Discard all' }));
    await expect(a).resolves.toBe(true);
  });

  it('a popover that opens after a click (its control gone) focuses Cancel, not the destructive answer', async () => {
    render(<><ArmLayer /><ConfirmDialog /></>);
    const gone = document.createElement('button');
    let a!: Promise<boolean>;
    act(() => { a = confirmAction(req(), { el: gone, rect: new DOMRect(10, 10, 20, 20), via: 'pointer', control: true, holds: 0 }); });
    expect(screen.getByRole('alertdialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent('go');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    clock.settle();
    press(screen.getByRole('button', { name: 'Discard all' }));
    await expect(a).resolves.toBe(true);
  });

  it('a popover goes under its anchor, or above it with no room below, on screen', () => {
    expect(placePopover({ left: 100, top: 50, bottom: 70 }, { w: 200, h: 100 }, { w: 800, h: 600 })).toEqual({ left: 100, top: 76 });
    expect(placePopover({ left: 700, top: 550, bottom: 570 }, { w: 200, h: 100 }, { w: 800, h: 600 })).toEqual({ left: 592, top: 444 });
    expect(placePopover(null, { w: 200, h: 100 }, { w: 800, h: 600 })).toEqual({ left: 300, top: 72 });
  });
});
