import type { AvatarPayload } from '../api/gen/AvatarPayload';
import { base64, utf8Bytes } from './engine/read/bytes';

const COLORS = ['#15a0bf', '#f25d2e', '#8b5cf6', '#e5a50a', '#2ec27e', '#e01b74'];

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** A 5×5 mirrored identicon for `key`. */
export function avatarSvg(key: string): string {
  const color = COLORS[fnv1a(key) % COLORS.length];
  const bits = fnv1a(`${key}#cells`);
  let cells = '';
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (!((bits >>> (y * 3 + x)) & 1)) continue;
      cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      if (x < 2) cells += `<rect x="${4 - x}" y="${y}" width="1" height="1"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.5 -0.5 6 6" width="64" height="64" shape-rendering="crispEdges"><rect x="-0.5" y="-0.5" width="6" height="6" fill="#f4f1ea"/><g fill="${color}">${cells}</g></svg>`;
}

export function avatarPayload(key: string): AvatarPayload {
  return { mime: 'image/svg+xml', base64: base64(utf8Bytes(avatarSvg(key))) };
}
