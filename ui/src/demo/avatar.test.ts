import { describe, expect, it } from 'vitest';
import { avatarPayload, avatarSvg } from './avatar';
import { avatarHandlers } from './handlers/avatars';

describe('avatars', () => {
  it('draws the same picture for the same key, and a different one for another', () => {
    expect(avatarSvg('ada@example.com')).toBe(avatarSvg('ada@example.com'));
    expect(avatarSvg('ada@example.com')).not.toBe(avatarSvg('grace@example.com'));
    expect(avatarSvg('x').startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it('answers SVG payloads keyed by the normalised email, and by URL for forge pictures', async () => {
    const ctx = {} as never;
    const a = await avatarHandlers.avatar({ email: ' Ada@Example.com ' }, ctx);
    expect(a).toEqual(avatarPayload('ada@example.com'));
    expect(a?.mime).toBe('image/svg+xml');
    expect(atob(a!.base64)).toBe(avatarSvg('ada@example.com'));
    expect(await avatarHandlers.forgeAvatarImage({ url: 'https://gitlab.example.com/uploads/ada.png' }, ctx)).toEqual(avatarPayload('https://gitlab.example.com/uploads/ada.png'));
  });
});
