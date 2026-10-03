import { initials } from '../format/initials';
import { useTheme } from '../theme/store';
import { useAvatar } from './avatarStore';
import { avatarLane } from './color';
import './avatar.css';

/** A person's avatar: initials on a lane-palette colour picked by the email, replaced by the
 * image once one arrives. Decorative: the name is always shown next to it (or in a tooltip).
 * `request: false`: never asks for the image itself (useAvatar). The graph's commit nodes draw
 * the same avatar on the canvas (graph/draw.ts), with the same `avatarLane`. */
export function Avatar({ name, email, size = 24, request = true }: { name: string; email: string; size?: number; request?: boolean }) {
  const img = useAvatar(email, request);
  const colors = useTheme((s) => s.colors);
  const lane = avatarLane(name, email, colors.graph.length);
  return (
    <span className="avatar" data-testid="avatar" aria-hidden style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: colors.graph[lane], color: colors.laneText[lane] }}>
      {img ? <img src={img.url} alt="" width={size} height={size} /> : initials(name)}
    </span>
  );
}
