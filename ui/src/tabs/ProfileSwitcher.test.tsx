import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAppState, EMPTY_PROFILE } from '../app/state';
import { useMenu } from '../menu/menuStore';
import { profileDotIcon, ProfileSwitcher } from './ProfileSwitcher';

describe('profile menu icons (K69)', () => {
  it('each profile row shows its colour as a dot; the current one has a ring', () => {
    const Other = profileDotIcon('#2ece9d', false);
    const Current = profileDotIcon('#d90171', true);
    const { container } = render(<><Other size={16} /><Current size={16} /></>);
    const [other, current] = container.querySelectorAll('svg');
    expect(other.querySelector('circle')!.getAttribute('fill')).toBe('#2ece9d');
    expect(other.querySelectorAll('circle')).toHaveLength(1);
    expect(current.querySelector('circle')!.getAttribute('fill')).toBe('#d90171');
    expect(current.querySelectorAll('circle')).toHaveLength(2);
  });

  it('one stable component per colour and state, so rows do not remount their icon', () => {
    expect(profileDotIcon('#4d88ff', false)).toBe(profileDotIcon('#4d88ff', false));
    expect(profileDotIcon('#4d88ff', true)).not.toBe(profileDotIcon('#4d88ff', false));
  });
});

describe('the profile picker opens on the current profile', () => {
  afterEach(() => { cleanup(); act(() => useMenu.getState().close()); });
  it('passes the current profile as the initial row', () => {
    const mk = (id: string) => ({ ...EMPTY_PROFILE, id, name: id, color: '#4d88ff' });
    useAppState.setState({ profiles: [mk('a'), mk('b')], profile: mk('b') });
    render(<ProfileSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Profile: b' }));
    expect(useMenu.getState().initialRow).toBe('profile.b');
  });
});
