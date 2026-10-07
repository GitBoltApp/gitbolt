import { act, fireEvent, render, screen } from '@testing-library/react';
import { Copy, ExternalLink, GitCommit, GitBranch } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArmLayer } from '../ui/arm/ArmLayer';
import { armClock, press } from '../ui/arm/armTesting';
import { disarm, holdOrigin, useArm } from '../ui/arm/store';
import { confirmAction, confirmWith } from '../ui/ConfirmDialog';
import { TooltipHost } from '../ui/TooltipHost';
import { useTooltip } from '../ui/tooltipStore';
import { BLUR_SETTLE_MS, ContextMenu, inTriangle, remap, SUBMENU_GRACE_MS } from './ContextMenu';
import { openContextMenu, openMenuAt, setMenuRowRunner, useMenu } from './menuStore';
import type { MenuRow } from './types';

function open(rows: MenuRow[], build?: () => MenuRow[]) {
  render(<><button type="button">before</button><ContextMenu /><TooltipHost /></>);
  act(() => useMenu.getState().show(rows, 10, 10, performance.now(), build));
  return screen.getByRole('menu');
}

const action = (id: string, run: () => void = () => {}, extra: Partial<Extract<MenuRow, { kind: 'action' }>> = {}): MenuRow => ({ kind: 'action', id, label: id.toUpperCase(), icon: Copy, tooltip: `tip ${id}`, run, ...extra });

describe('ContextMenu', () => {
  afterEach(() => act(() => useMenu.getState().close()));

  it('renders icon, label, variants; label runs the default; variants run theirs', () => {
    const full = vi.fn();
    const short = vi.fn();
    const menu = open([{ kind: 'action', id: 'sha', label: 'Copy SHA', icon: Copy, tooltip: 'Copy the commit id', run: full, variants: [
      { id: 'short', label: 'Short', tooltip: 'Copy the 7-character short SHA', run: short },
      { id: 'full', label: 'Full', tooltip: 'Copy the full 40-character SHA', run: full },
    ] }]);
    expect(menu.querySelector('[data-row-id="sha"] svg')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the 7-character short SHA' }));
    expect(short).toHaveBeenCalledOnce();
    expect(full).not.toHaveBeenCalled();
    expect(screen.getByRole('menu', { hidden: true })).not.toBeVisible();
  });

  it('runs rows and variants through the row-run hook, with their id and label (R11)', () => {
    const seen: string[] = [];
    const off = setMenuRowRunner((id, label, run) => { seen.push(`${id}:${label}`); run(); });
    const row = vi.fn();
    const variant = vi.fn();
    open([action('copy', row, { variants: [{ id: 'rel', label: 'Rel', tooltip: 'rel tip', run: variant }, { id: 'abs', tooltip: 'Absolute path', run: () => {} }] })]);
    fireEvent.click(screen.getByText('COPY'));
    act(() => useMenu.getState().show([action('copy', row, { variants: [{ id: 'abs', tooltip: 'Absolute path', run: variant }] })], 10, 10));
    fireEvent.click(screen.getByRole('button', { name: 'Absolute path' }));
    off();
    expect(seen).toEqual(['copy:COPY', 'abs:COPY: Absolute path']);
    expect(row).toHaveBeenCalledOnce();
    expect(variant).toHaveBeenCalledOnce();
  });

  it('shows row and variant tooltips immediately; a disabled variant shows its reason and does nothing', () => {
    const branch = vi.fn();
    open([{ kind: 'action', id: 'forge', label: 'Forge link', icon: ExternalLink, tooltip: 'Open on GitLab', run: () => {}, variants: [
      { id: 'branch', icon: GitBranch, tooltip: 'Branch page', run: branch, disabledReason: 'Not on the remote' },
      { id: 'commit', icon: GitCommit, tooltip: 'Commit permalink', run: () => {} },
    ] }]);
    fireEvent.pointerEnter(screen.getByText('Forge link'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Open on GitLab');
    const disabled = screen.getByRole('button', { name: 'Branch page' });
    fireEvent.pointerEnter(disabled);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Not on the remote');
    fireEvent.click(disabled);
    expect(branch).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeVisible();
  });

  it('hovering or focusing the row body highlights the variant the row runs; hovering a variant itself does not', () => {
    const menu = open([
      { kind: 'action', id: 'del', label: 'Delete', icon: Copy, tooltip: 'row tip', run: () => {}, defaultVariant: 'remote', variants: [
        { id: 'local', label: 'Local', tooltip: 'local tip', run: () => {}, disabledReason: "Can't delete dev: it's checked out" },
        { id: 'remote', label: 'Remote', tooltip: 'remote tip', run: () => {} },
      ] },
      action('other'),
    ]);
    const remote = () => menu.querySelector('[data-variant-id="remote"]')!;
    const local = () => menu.querySelector('[data-variant-id="local"]')!;
    // Keyboard focus on the row (it's the first, so active at open).
    expect(remote()).toHaveAttribute('data-default', 'true');
    expect(local()).not.toHaveAttribute('data-default');
    fireEvent.pointerEnter(screen.getByText('OTHER'));
    expect(remote()).not.toHaveAttribute('data-default');
    fireEvent.pointerEnter(screen.getByText('Delete'));
    expect(remote()).toHaveAttribute('data-default', 'true');
    fireEvent.pointerEnter(local());
    expect(remote()).not.toHaveAttribute('data-default');
    fireEvent.pointerLeave(local());
    expect(remote()).toHaveAttribute('data-default', 'true');
  });

  it('a disabled variant is visible, shows its reason, runs nothing, and is skipped by the arrows', () => {
    const local = vi.fn();
    const remote = vi.fn();
    const menu = open([{ kind: 'action', id: 'del', label: 'Delete', icon: Copy, tooltip: 'row tip', run: remote, variants: [
      { id: 'local', label: 'Local', tooltip: 'local tip', run: local, disabledReason: "Can't delete dev: it's checked out" },
      { id: 'remote', label: 'Remote', tooltip: 'remote tip', run: remote },
    ] }]);
    const l = menu.querySelector('[data-variant-id="local"]')!;
    expect(l).toHaveAttribute('aria-disabled', 'true');
    fireEvent.pointerEnter(l);
    expect(screen.getByRole('tooltip')).toHaveTextContent("Can't delete dev: it's checked out");
    fireEvent.click(l);
    expect(local).not.toHaveBeenCalled();
    fireEvent.keyDown(menu, { key: 'ArrowRight' });
    expect(menu.querySelector('[data-variant-id="remote"]')).toHaveAttribute('data-active', 'true');
    fireEvent.keyDown(menu, { key: 'ArrowLeft' });
    expect(menu.querySelector('[data-active="true"][data-variant-id]')).toBeNull();
  });

  // K25: the inline variants (e.g. Copy path's Rel/Abs) are a gapless button group; moving the
  // pointer from one straight into its neighbour must swap the tooltip directly, never hiding it
  // and never showing the row's tooltip in between (the store update a render could batch away).
  it('moving between variant siblings swaps the tooltip directly, never hidden or showing the row tooltip in between', () => {
    open([{ kind: 'action', id: 'copy', label: 'Copy path', icon: Copy, tooltip: 'row tip', run: () => {}, variants: [
      { id: 'rel', label: 'Rel', tooltip: 'rel tip', run: () => {} },
      { id: 'abs', label: 'Abs', tooltip: 'abs tip', run: () => {} },
    ] }]);
    const rel = screen.getByRole('button', { name: 'rel tip' });
    const abs = screen.getByRole('button', { name: 'abs tip' });
    fireEvent.pointerEnter(rel);
    expect(screen.getByRole('tooltip')).toHaveTextContent('rel tip');
    // Every tooltip-store transition the sibling-to-sibling crossing produces, recorded as it
    // happens (zustand notifies synchronously, independent of React's render batching).
    const seen: (string | null)[] = [];
    const unsub = useTooltip.subscribe((s) => seen.push(s.tip?.text ?? null));
    fireEvent.pointerLeave(rel, { relatedTarget: abs });
    unsub();
    expect(screen.getByRole('tooltip')).toHaveTextContent('abs tip');
    expect(seen).not.toContain(null); // never hidden
    expect(seen).not.toContain('row tip'); // never falls back to the row's tooltip mid-crossing
    expect(seen.at(-1)).toBe('abs tip');
    // Leaving the group entirely (not into a sibling) still falls back to the row's tooltip.
    fireEvent.pointerLeave(abs, { relatedTarget: screen.getByText('Copy path') });
    expect(screen.getByRole('tooltip')).toHaveTextContent('row tip');
  });

  it('a disabled row shows its reason, is skipped by the arrows and does nothing when clicked', () => {
    const b = vi.fn();
    open([action('a'), action('b', b, { disabledReason: 'Not here' })]);
    const row = screen.getByRole('menuitem', { name: 'B' });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    fireEvent.pointerEnter(row);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Not here');
    fireEvent.click(row);
    expect(b).not.toHaveBeenCalled();
  });

  it('keyboard: arrows skip separators and disabled rows, → enters variants, Enter runs, Esc closes', () => {
    const a = vi.fn();
    const v2 = vi.fn();
    const menu = open([
      { kind: 'action', id: 'a', label: 'A', icon: Copy, tooltip: 'a', run: a },
      { kind: 'separator' },
      { kind: 'action', id: 'b', label: 'B', icon: Copy, tooltip: 'b', run: () => {}, disabledReason: 'nope' },
      { kind: 'action', id: 'c', label: 'C', icon: Copy, tooltip: 'c', run: () => {}, variants: [
        { id: 'v1', label: 'V1', tooltip: 'v1', run: () => {} },
        { id: 'v2', label: 'V2', tooltip: 'v2', run: v2 },
      ] },
    ]);
    expect(menu.querySelector('[data-active="true"]')).toHaveAttribute('data-row-id', 'a');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(menu.querySelector('[data-active="true"]')).toHaveAttribute('data-row-id', 'c');
    // The keyboard's row shows its tooltip too.
    expect(screen.getByRole('tooltip')).toHaveTextContent('c');
    fireEvent.keyDown(menu, { key: 'ArrowRight' });
    fireEvent.keyDown(menu, { key: 'ArrowRight' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('v2');
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(v2).toHaveBeenCalledOnce();
    act(() => useMenu.getState().show([{ kind: 'action', id: 'a', label: 'A', icon: Copy, tooltip: 'a', run: a }], 0, 0, performance.now()));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.getByRole('menu', { hidden: true })).not.toBeVisible();
    expect(a).not.toHaveBeenCalled();
  });

  it('ArrowUp wraps; Tab closes', () => {
    const menu = open([action('a'), action('b'), action('c')]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(menu.querySelector('[data-active="true"]')).toHaveAttribute('data-row-id', 'c');
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(screen.getByRole('menu', { hidden: true })).not.toBeVisible();
  });

  it('submenus open with → (at their `initial` row) and close with ←', () => {
    const inner = vi.fn();
    const second = vi.fn();
    const menu = open([{ kind: 'submenu', id: 'more', label: 'More', icon: Copy, tooltip: 'more', initial: 'in2', rows: [
      { kind: 'action', id: 'in', label: 'Inner', icon: Copy, tooltip: 'in', run: inner },
      { kind: 'action', id: 'in2', label: 'Second', icon: Copy, tooltip: 'in2', run: second },
    ] }]);
    fireEvent.keyDown(menu, { key: 'ArrowRight' });
    expect(screen.getByText('Inner')).toBeVisible();
    expect(screen.getByRole('menu', { name: 'More' })).toBeVisible();
    fireEvent.keyDown(menu, { key: 'ArrowLeft' });
    expect(screen.queryByText('Inner')).toBeNull();
    fireEvent.keyDown(menu, { key: 'ArrowRight' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(inner).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  describe('hover intent', () => {
    const more: MenuRow = { kind: 'submenu', id: 'more', label: 'More', icon: Copy, tooltip: 'more tip', rows: [action('in'), action('in2')] };
    const sub = () => screen.queryByRole('menu', { name: 'More' });
    const hoverMore = () => fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'More' }));
    const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
    afterEach(() => vi.useRealTimers());

    it("a pointerenter opens the submenu synchronously (K29): no timer runs; its row's tooltip goes at once", () => {
      // Fake timers and no advance: if anything still depended on a timer, the submenu would stay closed.
      vi.useFakeTimers();
      open([more, action('b')]);
      hoverMore();
      expect(sub()).toBeVisible();
      // The tooltip beside the row would cover the submenu.
      expect(screen.queryByRole('tooltip')).toBeNull();
      // Back on the row with its submenu open: still no tooltip.
      fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'IN' }));
      hoverMore();
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    describe('the safe triangle', () => {
      // The submenu opened to the right, at x 300..500, y 0..100; its row "More" is left at
      // (100, 13): the triangle is (96, 13), (300, -4), (300, 104).
      const rect = (l: number, t: number, r: number, b: number) => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, x: l, y: t, toJSON() {} });
      let restore: () => void = () => {};
      const setupOpen = () => {
        const orig = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
          return this.matches('.ctx-level[data-depth="1"]') ? rect(300, 0, 500, 100) : rect(0, 0, 0, 0);
        };
        restore = () => { HTMLElement.prototype.getBoundingClientRect = orig; };
        vi.useFakeTimers();
        const menu = open([more, action('b'), action('c')]);
        hoverMore();
        expect(sub()).toBeVisible();
        fireEvent.pointerLeave(screen.getByRole('menuitem', { name: 'More' }), { clientX: 100, clientY: 13 });
        return menu;
      };
      const activeTop = (menu: HTMLElement) => menu.querySelector('[data-depth="0"] > [data-active="true"]')?.getAttribute('data-row-id');
      afterEach(() => restore());

      it('inTriangle', () => {
        const t = [{ x: 96, y: 13 }, { x: 300, y: -4 }, { x: 300, y: 104 }] as const;
        expect(inTriangle({ x: 150, y: 30 }, t)).toBe(true);
        expect(inTriangle({ x: 299, y: 100 }, t)).toBe(true);
        expect(inTriangle({ x: 100, y: 40 }, t)).toBe(false);
        expect(inTriangle({ x: 150, y: 90 }, t)).toBe(false);
      });

      it('a diagonal across siblings into the submenu keeps it open, however slow, as long as it keeps moving', () => {
        const menu = setupOpen();
        fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'B' }), { clientX: 150, clientY: 30 });
        for (let x = 160; x < 300; x += 20) {
          tick(SUBMENU_GRACE_MS - 50);
          fireEvent.pointerMove(document.body, { clientX: x, clientY: 30 + (x - 150) / 4 });
        }
        fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'C' }), { clientX: 290, clientY: 60 });
        expect(sub()).toBeVisible();
        // The parent row stays the active one while crossing.
        expect(activeTop(menu)).toBe('more');
        fireEvent.pointerEnter(sub()!);
        fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'IN2' }));
        tick(1000);
        expect(sub()).toBeVisible();
        expect(activeTop(menu)).toBe('more');
      });

      it(`resting on a sibling inside the triangle hands over after ${SUBMENU_GRACE_MS} ms`, () => {
        const menu = setupOpen();
        fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'B' }), { clientX: 150, clientY: 30 });
        tick(SUBMENU_GRACE_MS - 1);
        expect(sub()).toBeVisible();
        tick(1);
        expect(sub()).toBeNull();
        expect(activeTop(menu)).toBe('b');
      });

      it('leaving the triangle hands over at once', () => {
        const menu = setupOpen();
        fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'B' }), { clientX: 150, clientY: 30 });
        fireEvent.pointerMove(document.body, { clientX: 150, clientY: 90 });
        expect(sub()).toBeNull();
        expect(activeTop(menu)).toBe('b');
      });

      it('a move straight down (outside the triangle) hands over at once', () => {
        const menu = setupOpen();
        fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'B' }), { clientX: 100, clientY: 40 });
        expect(sub()).toBeNull();
        expect(activeTop(menu)).toBe('b');
      });
    });

    it('a click and the keyboard open at once; the row tooltip is hidden when the keyboard opens it', () => {
      vi.useFakeTimers();
      const menu = open([action('a'), more]);
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(screen.getByRole('tooltip')).toHaveTextContent('more tip');
      fireEvent.keyDown(menu, { key: 'ArrowRight' });
      expect(sub()).toBeVisible();
      expect(screen.queryByRole('tooltip')).toBeNull();
      fireEvent.keyDown(menu, { key: 'Escape' });
      expect(sub()).toBeNull();
      fireEvent.click(screen.getByRole('menuitem', { name: 'More' }));
      expect(sub()).toBeVisible();
    });
  });

  it('while open, keys never reach the app behind it: F7 and Shift+↓ do nothing, Esc closes the menu', () => {
    const appKeys = vi.fn();
    render(<><div data-testid="app" tabIndex={-1} onKeyDown={(e) => appKeys(e.key)} /><ContextMenu /></>);
    const app = screen.getByTestId('app');
    app.focus();
    act(() => useMenu.getState().show([action('a'), action('b')], 0, 0));
    const menu = screen.getByRole('menu');
    // Even with focus back in the app (a click that didn't close it, a stray focus call).
    app.focus();
    fireEvent.keyDown(app, { key: 'F7' });
    fireEvent.keyDown(app, { key: 'ArrowDown', shiftKey: true });
    expect(appKeys).not.toHaveBeenCalled();
    expect(menu.querySelector('[data-active="true"]')).toHaveAttribute('data-row-id', 'b');
    fireEvent.keyDown(app, { key: 'Escape' });
    expect(appKeys).not.toHaveBeenCalled();
    expect(screen.getByRole('menu', { hidden: true })).not.toBeVisible();
    // Closed: keys reach the app again.
    fireEvent.keyDown(app, { key: 'F7' });
    expect(appKeys).toHaveBeenCalledWith('F7');
  });

  it('names the active row with aria-activedescendant; an open submenu is owned by its row', () => {
    const menu = open([action('a'), { kind: 'submenu', id: 'more', label: 'More', icon: Copy, tooltip: 'more', rows: [action('in')] }]);
    expect(document.getElementById(menu.getAttribute('aria-activedescendant')!)).toHaveAttribute('data-row-id', 'a');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowRight' });
    expect(document.getElementById(menu.getAttribute('aria-activedescendant')!)).toHaveAttribute('data-row-id', 'in');
    const row = screen.getByRole('menuitem', { name: 'More' });
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(row.getAttribute('aria-owns')!)).toBe(screen.getByRole('menu', { name: 'More' }));
  });

  it('remap: a submenu whose active row is gone starts on its `initial` row', () => {
    const loading: MenuRow[] = [{ kind: 'submenu', id: 'o', label: 'O', icon: Copy, tooltip: 'o', rows: [action('loading', () => {}, { disabledReason: 'wait' })] }];
    const loaded: MenuRow[] = [{ kind: 'submenu', id: 'o', label: 'O', icon: Copy, tooltip: 'o', initial: 'y', rows: [action('x'), action('y')] }];
    const levels = remap([{ rows: loading, active: 0, variant: -1, left: 0, top: 0 }, { rows: (loading[0] as { rows: MenuRow[] }).rows, active: 0, variant: -1, left: 0, top: 0, anchor: { left: 0, right: 10, top: 0 }, parent: 0 }], loaded);
    expect(levels).toHaveLength(2);
    expect(levels[1].active).toBe(1);
  });

  it('a press outside closes it; a press inside does not', () => {
    open([action('a')]);
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'A' }));
    expect(screen.getByRole('menu')).toBeVisible();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'before' }));
    expect(screen.getByRole('menu', { hidden: true })).not.toBeVisible();
  });

  it('restores focus (I2) after a window blur or a resize, but leaves it alone after a press outside', () => {
    render(<><button type="button">before</button><ContextMenu /><TooltipHost /></>);
    const before = screen.getByRole('button', { name: 'before' });

    vi.useFakeTimers();
    before.focus();
    act(() => useMenu.getState().show([action('a')], 0, 0));
    expect(screen.getByRole('menu')).toHaveFocus();
    fireEvent(window, new Event('blur'));
    act(() => { vi.advanceTimersByTime(BLUR_SETTLE_MS); });
    vi.useRealTimers();
    expect(screen.getByRole('menu', { hidden: true })).not.toBeVisible();
    expect(before).toHaveFocus();

    before.focus();
    act(() => useMenu.getState().show([action('a')], 0, 0));
    fireEvent.resize(window);
    expect(before).toHaveFocus();
  });

  // K24: under GNOME (mutter on Xwayland), every button press in the window refocuses it
  // (WM_TAKE_FOCUS; vendor/tauri-runtime-cef/GITBOLT-PATCH.md), so the page gets a window blur and
  // then a focus a few ms after the right-click that opened the menu. Closing on that blur closed
  // every menu at once. Only a blur the window doesn't come back from closes it.
  it('a window focus bounce (a press under the window manager) keeps it open (K24); a real blur closes it', () => {
    vi.useFakeTimers();
    try {
      const menu = open([action('a')]);
      fireEvent(window, new Event('blur'));
      act(() => { vi.advanceTimersByTime(5); });
      fireEvent(window, new Event('focus'));
      act(() => { vi.advanceTimersByTime(BLUR_SETTLE_MS * 2); });
      expect(menu).toBeVisible();
      // Twice, as on a second press.
      fireEvent(window, new Event('blur'));
      fireEvent(window, new Event('focus'));
      act(() => { vi.advanceTimersByTime(BLUR_SETTLE_MS * 2); });
      expect(menu).toBeVisible();
      // Away for good (another window was activated): closed once the settle time is up.
      fireEvent(window, new Event('blur'));
      act(() => { vi.advanceTimersByTime(BLUR_SETTLE_MS - 1); });
      expect(menu).toBeVisible();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.getByRole('menu', { hidden: true })).not.toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a blur pending when the menu closes does not close the next one', () => {
    vi.useFakeTimers();
    try {
      open([action('a')]);
      fireEvent(window, new Event('blur'));
      act(() => useMenu.getState().close());
      act(() => useMenu.getState().show([action('b')], 10, 10));
      act(() => { vi.advanceTimersByTime(BLUR_SETTLE_MS * 2); });
      expect(screen.getByRole('menu')).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  // K1: a scroll event is dispatched in the frame after the scroll, so the tail of one the user
  // started before the right-click (a wheel notch, a smooth or kinetic scroll, the app putting a
  // list back) arrived after the menu opened, and closed it at once. As a native menu does, it
  // stays open; and the wheel outside it moves nothing behind it while it's open.
  it('a scroll does not close it (K1); the wheel outside it is swallowed while it is open', () => {
    const menu = open([action('a')]);
    const before = screen.getByRole('button', { name: 'before' });
    fireEvent.scroll(window);
    fireEvent.scroll(before);
    expect(menu).toBeVisible();
    const behind = vi.fn();
    before.addEventListener('wheel', behind);
    const outside = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });
    before.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(true);
    expect(behind).not.toHaveBeenCalled();
    expect(menu).toBeVisible();
    const inside = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });
    screen.getByRole('menuitem', { name: 'A' }).dispatchEvent(inside);
    expect(inside.defaultPrevented).toBe(false);
    // Closed, the wheel is the page's again.
    act(() => useMenu.getState().close());
    const after = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });
    before.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    expect(behind).toHaveBeenCalledOnce();
  });

  it('gives focus back to where it was on Escape and after a pick', () => {
    const a = vi.fn();
    render(<><button type="button">before</button><ContextMenu /><TooltipHost /></>);
    const before = screen.getByRole('button', { name: 'before' });
    before.focus();
    act(() => useMenu.getState().show([action('a', a)], 0, 0));
    expect(screen.getByRole('menu')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(before).toHaveFocus();
    act(() => useMenu.getState().show([action('a', () => a(document.activeElement))], 0, 0));
    fireEvent.click(screen.getByRole('menuitem', { name: 'A' }));
    // Focus is back before the action runs, so an action that moves focus wins.
    expect(a).toHaveBeenCalledWith(before);
  });

  it('a refresh re-runs the builder in place, keeping an open submenu and its row', () => {
    let n = 1;
    const build = (): MenuRow[] => [action('top'), { kind: 'submenu', id: 'sub', label: 'Sub', icon: Copy, tooltip: 'sub', rows: Array.from({ length: n }, (_, i) => action(`s${i}`)) }];
    const menu = open(build(), build);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowRight' });
    expect(screen.getAllByRole('menuitem').map((r) => r.dataset.rowId)).toEqual(['top', 'sub', 's0']);
    n = 3;
    act(() => useMenu.getState().refresh());
    expect(screen.getAllByRole('menuitem').map((r) => r.dataset.rowId)).toEqual(['top', 'sub', 's0', 's1', 's2']);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(menu.querySelector('[data-depth="1"] [data-active="true"]')).toHaveAttribute('data-row-id', 's1');
  });

  it('openContextMenu prevents the native menu, builds synchronously and records the latency', () => {
    render(<><ContextMenu /><TooltipHost /></>);
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 5, clientY: 6, timeStamp: performance.now() };
    act(() => openContextMenu(e, () => [action('a')]));
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeVisible();
    expect(window.__gbMenuLatency).toBeGreaterThanOrEqual(0);
    act(() => useMenu.getState().close());
    // No rows, no menu (the native one stays suppressed).
    act(() => openContextMenu(e, () => []));
    expect(screen.getByRole('menu', { hidden: true })).not.toBeVisible();
  });

  it('openMenuAt anchors below an element', () => {
    render(<><button type="button">anchor</button><ContextMenu /></>);
    const el = screen.getByRole('button');
    el.getBoundingClientRect = () => ({ left: 40, right: 80, top: 10, bottom: 30, width: 40, height: 20, x: 40, y: 10, toJSON() {} });
    act(() => openMenuAt(el, [action('a')]));
    expect(useMenu.getState()).toMatchObject({ x: 40, y: 30 });
    expect(screen.getByRole('menu', { name: 'Context menu' })).toBeVisible();
  });

  it("openMenuAt's label names the root menu (a dropdown's purpose); the next menu without one is generic again", () => {
    render(<><button type="button">anchor</button><ContextMenu /></>);
    const el = screen.getByRole('button');
    act(() => openMenuAt(el, [action('a')], undefined, undefined, 'Open in'));
    expect(screen.getByRole('menu', { name: 'Open in' })).toBeVisible();
    // A refresh (same menu, rebuilt rows) keeps it.
    act(() => useMenu.getState().refresh());
    expect(screen.getByRole('menu', { name: 'Open in' })).toBeVisible();
    act(() => useMenu.getState().close());
    act(() => openMenuAt(el, [action('b')]));
    expect(screen.getByRole('menu', { name: 'Context menu' })).toBeVisible();
  });
});

describe('ContextMenu: the anchor toggles it', () => {
  afterEach(() => act(() => useMenu.getState().close()));

  const setup = () => {
    const opened = vi.fn();
    const rows = [action('one', opened)];
    render(
      <>
        <button type="button" onClick={(e) => openMenuAt(e.currentTarget, rows)}>toggle</button>
        <button type="button">elsewhere</button>
        <ContextMenu />
      </>,
    );
    return screen.getByRole('button', { name: 'toggle' });
  };
  const press = (el: Element) => {
    fireEvent.pointerDown(el);
    fireEvent.pointerUp(el);
    fireEvent.click(el);
  };

  it('a second press on the opening button closes the menu and does not reopen it', () => {
    const toggle = setup();
    press(toggle);
    expect(useMenu.getState().rows).not.toBeNull();
    press(toggle);
    expect(useMenu.getState().rows).toBeNull();
  });

  it('the closing click stops there: neither the trigger nor anything above it runs', () => {
    const side = vi.fn();
    const parent = vi.fn();
    render(
      <div onClick={parent}>
        <button type="button" onClick={(e) => { openMenuAt(e.currentTarget, [action('one', vi.fn())]); side(); }}>toggle2</button>
        <ContextMenu />
      </div>,
    );
    const t = screen.getByRole('button', { name: 'toggle2' });
    press(t);
    expect(side).toHaveBeenCalledTimes(1);
    expect(parent).toHaveBeenCalledTimes(1);
    press(t);
    expect(useMenu.getState().rows).toBeNull();
    expect(side).toHaveBeenCalledTimes(1);
    expect(parent).toHaveBeenCalledTimes(1);
  });

  it('opens again on the press after that', async () => {
    const toggle = setup();
    press(toggle);
    press(toggle);
    await new Promise((r) => setTimeout(r, 5));
    press(toggle);
    expect(useMenu.getState().rows).not.toBeNull();
  });

  it('a press elsewhere closes it, and the anchor opens it normally afterwards', async () => {
    const toggle = setup();
    press(toggle);
    press(screen.getByRole('button', { name: 'elsewhere' }));
    expect(useMenu.getState().rows).toBeNull();
    press(toggle);
    expect(useMenu.getState().rows).not.toBeNull();
  });

  it('a press on the anchor that is never clicked does not swallow a later keyboard open', async () => {
    const toggle = setup();
    press(toggle);
    fireEvent.pointerDown(toggle);
    fireEvent.pointerUp(toggle); // dragged off: no click
    await new Promise((r) => setTimeout(r, 5));
    fireEvent.click(toggle); // e.g. Enter on the focused button
    expect(useMenu.getState().rows).not.toBeNull();
  });
});

describe('ContextMenu: an armed row (spec §ui confirms, board A)', () => {
  let clock: ReturnType<typeof armClock>;
  beforeEach(() => { clock = armClock(); });
  afterEach(() => { act(() => { disarm(); useMenu.getState().close(); }); clock.restore(); });
  const asking = (ran: () => void, arm = 'Click again to delete feature/x') => () => {
    void confirmAction({ title: 'Delete?', body: 'b', confirmLabel: 'Delete', arm, danger: true }).then((ok) => { if (ok) ran(); });
  };
  const openArmed = (rows: MenuRow[]) => {
    render(<><ContextMenu /><ArmLayer /><p>outside</p></>);
    act(() => useMenu.getState().show(rows, 10, 10));
  };

  it('the first pick arms the row in place and the menu stays; the second runs it and closes the menu', async () => {
    const ran = vi.fn();
    openArmed([action('delete', asking(ran)), action('other')]);
    fireEvent.click(screen.getByText('DELETE'));
    const row = screen.getByRole('menuitem', { name: 'Click again to delete feature/x' });
    expect(row).toHaveAttribute('data-armed', 'danger');
    expect(screen.getByRole('menu')).toBeVisible();
    // A double click's second click doesn't confirm, nor a press before the settle.
    fireEvent.pointerDown(row);
    fireEvent.click(row, { detail: 2 });
    press(row);
    await Promise.resolve();
    expect(ran).not.toHaveBeenCalled();
    clock.settle();
    press(row);
    await vi.waitFor(() => expect(ran).toHaveBeenCalledOnce());
    expect(screen.getByRole('menu', { hidden: true })).not.toBeVisible();
  });

  it('a click on another row only disarms (the menu stays, that row does not run); Esc disarms too', async () => {
    const ran = vi.fn();
    const other = vi.fn();
    openArmed([action('delete', asking(ran)), action('other', other)]);
    fireEvent.click(screen.getByText('DELETE'));
    const next = screen.getByText('OTHER').closest('[role="menuitem"]')!;
    fireEvent.pointerDown(next);
    fireEvent.click(next);
    expect(useArm.getState().armed).toBeNull();
    expect(other).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeVisible();

    fireEvent.click(screen.getByText('DELETE'));
    expect(useArm.getState().armed).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useArm.getState().armed).toBeNull();
    expect(screen.getByRole('menu')).toBeVisible();
    await Promise.resolve();
    expect(ran).not.toHaveBeenCalled();
  });

  it('Enter arms the active row and a second, fresh Enter runs it; a held Enter never does', async () => {
    const ran = vi.fn();
    openArmed([action('delete', asking(ran))]);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByRole('menuitem', { name: 'Click again to delete feature/x' })).toBeInTheDocument();
    clock.settle();
    fireEvent.keyDown(window, { key: 'Enter', repeat: true });
    await Promise.resolve();
    expect(ran).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Enter' });
    await vi.waitFor(() => expect(ran).toHaveBeenCalledOnce());
  });

  it('a refresh of its rows (the plan may have changed) disarms the row', () => {
    openArmed([action('delete', asking(() => {}))]);
    fireEvent.click(screen.getByText('DELETE'));
    expect(useArm.getState().armed).not.toBeNull();
    act(() => useMenu.setState({ rows: [action('delete', asking(() => {}))] }));
    expect(useArm.getState().armed).toBeNull();
  });


  it('a press outside disarms and closes the menu', () => {
    openArmed([action('delete', asking(() => {}))]);
    fireEvent.click(screen.getByText('DELETE'));
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(useArm.getState().armed).toBeNull();
    expect(screen.getByRole('menu', { hidden: true })).not.toBeVisible();
  });

  describe('with an option (UX round 3: a stack rebase)', () => {
    const option = { label: 'Also move 2 stacked branches', detail: 'feature/a, feature/b', checked: true };
    const rebasing = (ran: (checked: boolean) => void) => () => {
      void confirmWith({ title: 'Rebase feature/c onto main?', confirmLabel: 'Rebase', arm: 'Click again to rebase feature/c onto main', option }).then((a) => { if (a.ok) ran(a.checked); });
    };

    it('shows the checkbox right under the armed row, nothing above it moves; toggling never disarms; the second pick runs with its value', async () => {
      const ran = vi.fn();
      openArmed([action('above'), action('rebase', rebasing(ran)), action('below')]);
      const menu = screen.getByRole('menu');
      const place = menu.getAttribute('style');
      const above = screen.getByText('ABOVE').closest('[role="menuitem"]')!;
      expect(screen.queryByRole('menuitemcheckbox')).toBeNull();
      fireEvent.click(screen.getByText('REBASE'));
      const row = screen.getByRole('menuitem', { name: 'Click again to rebase feature/c onto main' });
      const box = screen.getByRole('menuitemcheckbox', { name: /Also move 2 stacked branches ?\(feature\/a, feature\/b\)/ });
      // Right under the armed row: the rows above and the menu's place stay; the menu grows downward.
      expect(row.nextElementSibling).toBe(box);
      expect(box.nextElementSibling).toBe(screen.getByText('BELOW').closest('[role="menuitem"]'));
      expect(row.previousElementSibling).toBe(above);
      expect(menu.getAttribute('style')).toBe(place);
      expect(box).toHaveAttribute('aria-checked', 'true');
      // Toggling (a press on it, then its click) keeps the row armed.
      clock.settle();
      press(box);
      expect(box).toHaveAttribute('aria-checked', 'false');
      expect(useArm.getState().armed).not.toBeNull();
      expect(screen.getByRole('menu')).toBeVisible();
      await Promise.resolve();
      expect(ran).not.toHaveBeenCalled();
      // The second pick on the row runs it with the box's value.
      press(row);
      await vi.waitFor(() => expect(ran).toHaveBeenCalledWith(false));
      expect(screen.getByRole('menu', { hidden: true })).not.toBeVisible();
    });

    it('keyboard: ↓ reaches the checkbox and Space toggles it, ↑ goes back, Enter runs; all without disarming', async () => {
      const ran = vi.fn();
      openArmed([action('rebase', rebasing(ran)), action('below')]);
      fireEvent.keyDown(window, { key: 'Enter' });
      const box = screen.getByRole('menuitemcheckbox');
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(screen.getByRole('menu')).toHaveAttribute('aria-activedescendant', box.id);
      fireEvent.keyDown(window, { key: ' ' });
      expect(box).toHaveAttribute('aria-checked', 'false');
      fireEvent.keyDown(window, { key: ' ' });
      fireEvent.keyDown(window, { key: ' ' });
      fireEvent.keyDown(window, { key: 'ArrowUp' });
      expect(useArm.getState().armed).not.toBeNull();
      clock.settle();
      fireEvent.keyDown(window, { key: 'Enter' });
      await vi.waitFor(() => expect(ran).toHaveBeenCalledWith(false));
    });

    it('a disarm (Esc) drops the checkbox and runs nothing', async () => {
      const ran = vi.fn();
      openArmed([action('rebase', rebasing(ran))]);
      fireEvent.click(screen.getByText('REBASE'));
      expect(screen.getByRole('menuitemcheckbox')).toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('menuitemcheckbox')).toBeNull();
      await Promise.resolve();
      expect(ran).not.toHaveBeenCalled();
    });
  });

  it('a held row keeps its menu open until the action knows whether to ask (an integrate preview)', async () => {
    let finish!: (ask: boolean) => void;
    const ran = vi.fn();
    openArmed([action('rebase', () => {
      const release = holdOrigin();
      void new Promise<boolean>((r) => { finish = r; }).then((ask) => {
        if (ask) { const p = confirmAction({ title: 'Rebase?', body: 'b', confirmLabel: 'Rebase', arm: 'Click again to rebase onto main (2 commits)' }); release(); void p.then((ok) => ok && ran()); } else { release(); ran(); }
      });
    })]);
    fireEvent.click(screen.getByText('REBASE'));
    expect(screen.getByRole('menu')).toBeVisible();
    await act(async () => { finish(true); });
    expect(screen.getByRole('menuitem', { name: 'Click again to rebase onto main (2 commits)' })).toHaveAttribute('data-armed', 'positive');
    expect(screen.getByRole('menu')).toBeVisible();
  });
});

describe('ContextMenu: the anchor keeps aria-expanded', () => {
  afterEach(() => act(() => useMenu.getState().close()));
  it('is true while open and false after the toggle press', () => {
    render(<><button type="button" onClick={(e) => openMenuAt(e.currentTarget, [action('one')])}>t</button><ContextMenu /></>);
    const t = screen.getByRole('button', { name: 't' });
    fireEvent.pointerDown(t); fireEvent.pointerUp(t); fireEvent.click(t);
    expect(t.getAttribute('aria-expanded')).toBe('true');
    fireEvent.pointerDown(t); fireEvent.pointerUp(t); fireEvent.click(t);
    expect(t.getAttribute('aria-expanded')).toBe('false');
  });
});
