import { initials } from '../format/initials';
import { useTheme } from '../theme/store';
import { avatarKey, useAvatar } from './avatarStore';
import './avatar.css';

/** FNV-1a: a stable colour per person. */
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/** A person's avatar: initials on a lane-palette colour picked by the email, replaced by the
 * image once one arrives. Decorative: the name is always shown next to it (or in a tooltip).
 * `request: false`: never asks for the image itself (useAvatar). */
export function Avatar({ name, email, size = 24, request = true }: { name: string; email: string; size?: number; request?: boolean }) {
  const img = useAvatar(email, request);
  const colors = useTheme((s) => s.colors);
  const lane = hash(avatarKey(email) || name) % colors.graph.length;
  return (
    <span className="avatar" data-testid="avatar" aria-hidden style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: colors.graph[lane], color: colors.laneText[lane] }}>
      {img ? <img src={img.url} alt="" width={size} height={size} /> : initials(name)}
    </span>
  );
}
