import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lend, lentHandler, useLend } from './lent';
import { EMPTY_PROFILE, useAppState } from './state';

const tabs = (active: string) => useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/t', alias: null }, { id: 'u', kind: 'repo', path: '/u', alias: null }], activeTab: active } });

describe('lent handlers', () => {
  afterEach(() => tabs('t'));

  it("are the active tab's, while lent", () => {
    tabs('t');
    const fn = vi.fn();
    const off = lend('x.go', 'u', fn);
    expect(lentHandler('x.go')).toBeNull();
    tabs('u');
    lentHandler('x.go')?.();
    expect(fn).toHaveBeenCalledOnce();
    off();
    expect(lentHandler('x.go')).toBeNull();
  });

  it('useLend lends the latest function while it is given one', () => {
    tabs('t');
    const first = vi.fn();
    const second = vi.fn();
    function View({ fn }: { fn: (() => void) | null }) {
      useLend('x.view', 't', fn);
      return null;
    }
    const r = render(<View fn={first} />);
    r.rerender(<View fn={second} />);
    act(() => lentHandler('x.view')?.());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    r.rerender(<View fn={null} />);
    expect(lentHandler('x.view')).toBeNull();
    r.rerender(<View fn={first} />);
    expect(lentHandler('x.view')).not.toBeNull();
    r.unmount();
    expect(lentHandler('x.view')).toBeNull();
  });
});
