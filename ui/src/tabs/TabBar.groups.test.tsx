import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabGroup } from '../api/gen/TabGroup';

vi.mock('../api/client', () => ({
  api: { openIn: vi.fn(async () => null), saveProfile: vi.fn(async () => null), saveSettings: vi.fn(async () => null), appInfo: vi.fn(async () => ({ appVersion: 'x', gitVersion: 'y' })) },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));

const { useAppState, EMPTY_PROFILE } = await import('../app/state');
const { TabBar } = await import('./TabBar');
const { useGroupUi, GROUP_LIST_DELAY_MS } = await import('./groupUi');
const { ArmLayer } = await import('../ui/arm/ArmLayer');
const { armClock, press } = await import('../ui/arm/armTesting');
const { disarm } = await import('../ui/arm/store');

const tab = (id: string) => ({ id, kind: 'repo' as const, path: `/${id}`, alias: null, worktree: null });
const group = (id: string, tabs: string[], extra: Partial<TabGroup> = {}): TabGroup => ({ id, name: '', color: 'blue', collapsed: false, tabs, ...extra });

function setTabs(ids: string[], active: string, groups: TabGroup[] = []) {
  act(() => {
    useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: ids.map(tab), activeTab: active, tabGroups: groups } });
  });
}
const profile = () => useAppState.getState().profile;
const order = () => profile().tabs.map((t) => t.id).join('');
const members = () => Object.fromEntries(profile().tabGroups.map((g) => [g.id, g.tabs.join('')]));
const chip = (name: RegExp | string = /^Tab group/) => screen.getByRole('button', { name });
const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent);

/** jsdom has no layout: strip items laid end to end in DOM order, chips 20 px, tabs 100 px, in a
 * 600 px strip. */
function layout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const key = this.dataset.stripKey;
    let left = 0;
    let width = 600;
    if (key) {
      const items = [...(this.parentElement?.querySelectorAll<HTMLElement>(':scope > [data-strip-key]') ?? [])];
      const w = (el: HTMLElement) => (el.dataset.stripKey!.startsWith('chip:') ? 20 : 100);
      left = items.slice(0, items.indexOf(this)).reduce((s, el) => s + w(el), 0);
      width = w(this);
    }
    return { left, right: left + width, width, top: 0, bottom: 30, height: 30, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}
const moveTo = (clientX: number) => act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX })); });
const release = (clientX: number) => act(() => { window.dispatchEvent(new MouseEvent('pointerup', { clientX })); });
const settle = () => act(() => { vi.advanceTimersByTime(150); });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  act(() => { useGroupUi.getState().closeMenu(); useGroupUi.getState().closeList(); });
  useAppState.setState({ profile: EMPTY_PROFILE });
});

describe('the group chip', () => {
  it('sits before the group\'s first tab, showing its name (or only its colour), with the tabs\' top border colour', () => {
    setTabs(['a', 'b', 'c', 'd'], 'a', [group('g1', ['b', 'c'], { name: 'Backend', color: 'green' }), group('g2', ['d'], { color: 'red' })]);
    render(<TabBar />);
    const strip = screen.getByRole('tablist');
    const keys = [...strip.querySelectorAll<HTMLElement>('[data-strip-key]')].map((el) => el.dataset.stripKey);
    expect(keys).toEqual(['tab:a', 'chip:g1', 'tab:b', 'tab:c', 'chip:g2', 'tab:d']);
    expect(chip(/Backend/)).toHaveTextContent('Backend');
    expect(chip('Tab group: Red')).toHaveTextContent('');
    expect(chip(/Backend/).dataset.groupColor).toBe('green');
    const [a, b] = screen.getAllByRole('tab');
    expect(b.classList.contains('grouped')).toBe(true);
    expect(b.dataset.groupColor).toBe('green');
    expect(a.classList.contains('grouped')).toBe(false);
  });

  it('a click collapses it to the chip (the active tab stays shown) and expands it again', () => {
    setTabs(['a', 'b', 'c', 'd'], 'c', [group('g1', ['b', 'c'], { name: 'Web' })]);
    render(<TabBar />);
    fireEvent.click(chip(/Web/));
    expect(profile().tabGroups[0].collapsed).toBe(true);
    expect(chip(/Web/)).toHaveAttribute('aria-expanded', 'false');
    expect(tabNames()).toEqual(['a', 'c', 'd']);
    // b stays laid out (at no width, tabs.css), out of reach, so collapsing and expanding animate.
    const b = document.querySelector<HTMLElement>('[data-tab-id="b"]')!;
    expect(b.classList.contains('tab-hidden')).toBe(true);
    expect(b).toHaveAttribute('aria-hidden', 'true');
    expect(b.hasAttribute('inert')).toBe(true);
    expect(b.dataset.stripKey).toBeUndefined();
    fireEvent.click(chip(/Web/));
    expect(b.classList.contains('tab-hidden')).toBe(false); // the same element grows back
    expect(tabNames()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('each group\'s top border is one element over the strip (GroupLines places it)', () => {
    setTabs(['a', 'b', 'c', 'd'], 'a', [group('g1', ['b', 'c'], { color: 'green' }), group('g2', ['d'], { color: 'red' })]);
    render(<TabBar />);
    const lines = [...screen.getByRole('tablist').querySelectorAll<HTMLElement>('.tg-line')];
    expect(lines.map((l) => l.dataset.groupColor)).toEqual(['green', 'red']);
    expect(lines.every((l) => l.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('keyboard: arrows reach the chip, Enter and Space toggle it', () => {
    setTabs(['a', 'b'], 'a', [group('g1', ['b'], { name: 'Web' })]);
    render(<TabBar />);
    const [a] = screen.getAllByRole('tab');
    a.focus();
    fireEvent.keyDown(a, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(chip(/Web/));
    fireEvent.keyDown(chip(/Web/), { key: 'Enter' });
    expect(profile().tabGroups[0].collapsed).toBe(true);
    fireEvent.keyDown(chip(/Web/), { key: ' ' });
    expect(profile().tabGroups[0].collapsed).toBe(false);
    fireEvent.keyDown(chip(/Web/), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getAllByRole('tab')[1]);
  });
});

describe('the group menu (right-click or the menu key on the chip)', () => {
  const open = (groups = [group('g1', ['b', 'c'], { name: 'Web' })]) => {
    setTabs(['a', 'b', 'c', 'd'], 'a', groups);
    render(<><TabBar /><ArmLayer /></>);
    fireEvent.contextMenu(chip(/Web/));
    return screen.getByRole('dialog', { name: 'Tab group' });
  };

  it('names the group as you type and recolours it from the nine swatches', () => {
    const menu = open();
    const name = within(menu).getByLabelText('Group name') as HTMLInputElement;
    expect(document.activeElement).toBe(name);
    expect(name.placeholder).toMatch(/^Example: /);
    fireEvent.change(name, { target: { value: 'Frontend' } });
    expect(profile().tabGroups[0].name).toBe('Frontend');
    const swatches = within(menu).getAllByRole('radio');
    expect(swatches).toHaveLength(9);
    expect(within(menu).getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(menu).getByRole('radio', { name: 'Purple' }));
    expect(profile().tabGroups[0].color).toBe('purple');
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(screen.queryByRole('dialog', { name: 'Tab group' })).toBeNull();
  });

  it('Esc closes it, back on the chip', () => {
    open();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(screen.queryByRole('dialog', { name: 'Tab group' })).toBeNull();
    expect(document.activeElement).toBe(chip(/Web/));
  });

  it('New tab in group, Ungroup tabs', () => {
    let menu = open();
    fireEvent.click(within(menu).getByRole('button', { name: 'New tab in group' }));
    expect(profile().tabGroups[0].tabs).toHaveLength(3);
    expect(profile().tabs[3].kind).toBe('open');
    menu = (fireEvent.contextMenu(chip(/Web/)), screen.getByRole('dialog', { name: 'Tab group' }));
    fireEvent.click(within(menu).getByRole('button', { name: 'Ungroup tabs' }));
    expect(profile().tabGroups).toEqual([]);
    expect(profile().tabs).toHaveLength(5);
  });

  it('Save and close group saves it and closes its tabs', () => {
    const menu = open();
    fireEvent.click(within(menu).getByRole('button', { name: 'Save and close group' }));
    expect(order()).toBe('ad');
    expect(profile().savedGroups).toEqual([{ id: 'g1', name: 'Web', color: 'blue', tabs: [{ path: '/b', alias: null, worktree: null }, { path: '/c', alias: null, worktree: null }] }]);
  });

  it('Delete group arms in place first; the second click closes its tabs', async () => {
    const clock = armClock();
    // jsdom does no layout: a rendered control reports one box, so it's "shown" and arms in place.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
      return (this.isConnected ? [new DOMRect(10, 10, 24, 24)] : []) as unknown as DOMRectList;
    });
    try {
      const menu = open();
      act(() => press(within(menu).getByRole('button', { name: 'Delete group' })));
      expect(order()).toBe('abcd');
      const overlay = () => document.querySelector<HTMLElement>('[data-arm-overlay]');
      expect(overlay()).toHaveTextContent('Click again to close 2 tabs');
      clock.settle();
      await act(async () => { press(overlay()!); });
      expect(order()).toBe('ad');
      expect(profile().tabGroups).toEqual([]);
      expect(screen.queryByRole('dialog', { name: 'Tab group' })).toBeNull();
    } finally {
      act(() => disarm());
      clock.restore();
    }
  });
});

describe('the chip\'s list of its tabs (hover, or ArrowDown)', () => {
  it('shows after the hover delay, lists the group\'s tabs with the active one marked, and a row switches to that tab without expanding', () => {
    vi.useFakeTimers();
    setTabs(['a', 'b', 'c'], 'a', [group('g1', ['b', 'c'], { name: 'Web', collapsed: true })]);
    useAppState.setState({ profile: { ...profile(), tabs: profile().tabs.map((t) => (t.id === 'c' ? { ...t, alias: 'Site' } : t)) } });
    render(<TabBar />);
    fireEvent.mouseEnter(chip(/Web/));
    act(() => { vi.advanceTimersByTime(GROUP_LIST_DELAY_MS - 10); });
    expect(screen.queryByRole('menu', { name: 'Tabs in Web' })).toBeNull();
    act(() => { vi.advanceTimersByTime(10); });
    const list = screen.getByRole('menu', { name: 'Tabs in Web' });
    expect(within(list).getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual(['b', 'Site']);
    expect(within(list).getAllByRole('menuitemradio').map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false']);
    // Moving from the chip onto the list keeps it.
    fireEvent.mouseLeave(chip(/Web/), { relatedTarget: list });
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.click(within(list).getByRole('menuitemradio', { name: 'Site' }));
    expect(profile().activeTab).toBe('c');
    expect(profile().tabGroups[0].collapsed).toBe(true);
    expect(tabNames()).toEqual(['a', 'Site']);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('moving away closes it', () => {
    vi.useFakeTimers();
    setTabs(['a', 'b'], 'a', [group('g1', ['b'], { name: 'Web' })]);
    render(<TabBar />);
    fireEvent.mouseEnter(chip(/Web/));
    act(() => { vi.advanceTimersByTime(GROUP_LIST_DELAY_MS); });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseLeave(chip(/Web/), { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keyboard: ArrowDown on the chip opens it on its first row; arrows move, Enter activates, Esc goes back to the chip', () => {
    setTabs(['a', 'b', 'c'], 'a', [group('g1', ['b', 'c'], { name: 'Web' })]);
    render(<TabBar />);
    chip(/Web/).focus();
    fireEvent.keyDown(chip(/Web/), { key: 'ArrowDown' });
    const rows = within(screen.getByRole('menu')).getAllByRole('menuitemradio');
    expect(document.activeElement).toBe(rows[0]);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); });
    expect(document.activeElement).toBe(rows[1]);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(chip(/Web/));
    fireEvent.keyDown(chip(/Web/), { key: 'ArrowDown' });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });
    expect(profile().activeTab).toBe('c');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('never shows while the chip is pressed or dragged', () => {
    vi.useFakeTimers();
    setTabs(['a', 'b'], 'a', [group('g1', ['b'], { name: 'Web' })]);
    render(<TabBar />);
    layout();
    fireEvent.mouseEnter(chip(/Web/));
    fireEvent.pointerDown(chip(/Web/), { button: 0, clientX: 110 });
    act(() => { vi.advanceTimersByTime(GROUP_LIST_DELAY_MS); });
    expect(screen.queryByRole('menu')).toBeNull();
    moveTo(60);
    release(60);
    settle();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('dragging with groups', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('a tab dropped onto the middle of another makes a group; the target shows the drop', () => {
    setTabs(['a', 'b', 'c'], 'a');
    render(<TabBar />);
    layout();
    const [a, b] = screen.getAllByRole('tab');
    fireEvent.pointerDown(a, { button: 0, clientX: 50 });
    moveTo(100); // a's right edge at 150: the middle of b (100..200)
    expect(b.classList.contains('drop-onto')).toBe(true);
    expect(a.classList.contains('grouped')).toBe(true); // the preview: a gains the new group's border
    expect(b.style.transform).toBe(''); // b doesn't slide
    // One line over the two, in the new group's colour.
    const line = [...screen.getByRole('tablist').querySelectorAll<HTMLElement>('.tg-line')];
    expect(line.map((l) => l.dataset.groupColor)).toEqual(['blue']);
    release(100);
    expect(order()).toBe('abc'); // a slides in beside b first
    expect(profile().tabGroups).toEqual([]);
    settle();
    expect(order()).toBe('abc');
    expect(members()).toEqual({ [profile().tabGroups[0].id]: 'ab' });
    expect(profile().tabGroups[0].color).toBe('blue');
  });

  it('a tab dragged into a group\'s span previews its border ("sticky"), and joins it on release', () => {
    setTabs(['a', 'b', 'c', 'd'], 'a', [group('g1', ['b', 'c'], { color: 'pink' })]);
    render(<TabBar />);
    layout();
    // Laid out: a 0..100, chip 100..120, b 120..220, c 220..320, d 320..420.
    const a = screen.getAllByRole('tab')[0];
    fireEvent.pointerDown(a, { button: 0, clientX: 50 });
    moveTo(180); // a's right edge at 230: past b's far zone (190), short of c's middle (250)
    expect(a.classList.contains('grouped')).toBe(true);
    expect(a.dataset.groupColor).toBe('pink');
    release(180);
    settle();
    expect(order()).toBe('bacd');
    expect(members()).toEqual({ g1: 'bac' });
  });

  it('a member dragged out of the span loses the border, and leaves on release', () => {
    setTabs(['a', 'b', 'c', 'd'], 'a', [group('g1', ['b', 'c'], { color: 'pink' })]);
    render(<TabBar />);
    layout();
    const c = screen.getAllByRole('tab')[2]; // 220..320
    fireEvent.pointerDown(c, { button: 0, clientX: 270 });
    moveTo(310); // 40 px: its middle short of the group's end (b's, then its own: 320)
    expect(c.dataset.groupColor).toBe('pink');
    moveTo(395); // its middle past the group's end, and its right edge past d's far zone
    expect(c.classList.contains('grouped')).toBe(false);
    release(395);
    settle();
    expect(order()).toBe('abdc');
    expect(members()).toEqual({ g1: 'b' });
  });

  it('the last group in the strip: its last tab leaves it to the right, into the empty strip', () => {
    setTabs(['a', 'b', 'c'], 'a', [group('g1', ['b', 'c'], { color: 'pink' })]);
    render(<TabBar />);
    layout();
    // a 0..100, chip 100..120, b 120..220, c 220..320, then empty strip to 600.
    const c = screen.getAllByRole('tab')[2];
    fireEvent.pointerDown(c, { button: 0, clientX: 270 });
    moveTo(330); // 60 px right: its middle past the group's end
    expect(c.style.transform).toBe('translateX(60px)');
    expect(c.classList.contains('grouped')).toBe(false);
    release(330);
    settle();
    expect(order()).toBe('abc');
    expect(members()).toEqual({ g1: 'b' });
  });

  it('a one-tab group\'s first slot: the chip stays put while the dragged tab is just past it', () => {
    setTabs(['a', 'b', 'y'], 'a', [group('g1', ['b'], { color: 'pink' })]);
    render(<TabBar />);
    layout();
    // a 0..100, chip 100..120, b 120..220, y 220..320: y dragged left over b and the chip.
    const y = screen.getAllByRole('tab')[2];
    fireEvent.pointerDown(y, { button: 0, clientX: 270 });
    moveTo(150); // its left edge at 100, over the chip: the group's first tab
    expect(y.dataset.groupColor).toBe('pink');
    expect(chip().style.transform).toBe('');
    expect(screen.getAllByRole('tab')[1].style.transform).toBe('translateX(100px)'); // b slides right
    release(150);
    settle();
    expect(order()).toBe('ayb');
    expect(members()).toEqual({ g1: 'yb' });
  });

  it('a tab moved from one group into the next keeps the colour it previewed through the drop, in one update', () => {
    setTabs(['a', 'b', 'c'], 'a', [group('g1', ['a', 'b'], { color: 'pink' }), group('g2', ['c'], { color: 'green' })]);
    render(<TabBar />);
    layout();
    // chip1 0..20, a 20..120, b 120..220, chip2 220..240, c 240..340: b dragged right into g2.
    const b = screen.getAllByRole('tab')[1];
    fireEvent.pointerDown(b, { button: 0, clientX: 170 });
    // Out of g1 40 px on, then 40 px between the groups: g2's first tab.
    moveTo(260);
    expect(b.dataset.groupColor).toBe('green');
    expect(chip('Tab group: Green').style.transform).toBe('translateX(-100px)');
    const updates: string[] = [];
    const off = useAppState.subscribe(() => updates.push(JSON.stringify(members())));
    release(260);
    expect(b.dataset.groupColor).toBe('green'); // settling: still the previewed colour
    settle();
    off();
    expect(updates).toEqual([JSON.stringify({ g1: 'a', g2: 'bc' })]);
    expect(order()).toBe('abc');
    expect(b.dataset.groupColor).toBe('green');
    expect(chip('Tab group: Green').style.transform).toBe('');
  });

  it('dragging the chip moves the whole group', () => {
    setTabs(['a', 'b', 'c', 'd'], 'a', [group('g1', ['a', 'b'], { name: 'Web' })]);
    render(<TabBar />);
    layout();
    // chip 0..20, a 20..120, b 120..220, c 220..320, d 320..420: the group's block is 0..220.
    fireEvent.pointerDown(chip(/Web/), { button: 0, clientX: 10 });
    moveTo(70); // the block's right edge at 280: past c's midpoint (270)
    expect(chip(/Web/).style.transform).toBe('translateX(60px)');
    expect(screen.getAllByRole('tab')[0].style.transform).toBe('translateX(60px)');
    expect(screen.getAllByRole('tab')[2].style.transform).toBe('translateX(-220px)');
    release(70);
    settle();
    expect(order()).toBe('cabd');
    expect(members()).toEqual({ g1: 'ab' });
    expect(profile().tabGroups[0].collapsed).toBe(false); // the release isn't a click
  });
});

describe('the tab bar\'s empty space', () => {
  it('a double-click opens the Open repository screen; a double-click on a tab still renames it', () => {
    setTabs(['a'], 'a');
    render(<TabBar />);
    fireEvent.doubleClick(screen.getAllByRole('tab')[0]);
    expect(profile().tabs).toHaveLength(1);
    fireEvent.doubleClick(screen.getByRole('tablist'));
    // `file.openRepo` (coreActions.ts): a new tab on the Open repository screen.
    expect(profile().tabs.map((t) => t.kind)).toEqual(['repo', 'open']);
    expect(profile().activeTab).toBe(profile().tabs[1].id);
  });
});
