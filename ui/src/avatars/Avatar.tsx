import type { ForgeUser } from '../api/gen/ForgeUser';
import { initials } from '../format/initials';
import { useTheme } from '../theme/store';
import { useAvatar } from './avatarStore';
import { avatarLane } from './color';
import './avatar.css';

/** A person's avatar: initials on a lane-palette colour picked by the email, replaced by the
 * image once one arrives. Decorative: the name is always shown next to it (or in a tooltip).
 * `request: false`: never asks for the image itself (useAvatar). `url`: a forge user's picture
 * (`ForgeAvatar`), fetched by the backend instead of the email's. The graph's commit nodes draw
 * the same avatar on the canvas (graph/draw.ts), with the same `avatarLane`. */
export function Avatar({ name, email, size = 24, request = true, url = null }: { name: string; email: string; size?: number; request?: boolean; url?: string | null }) {
  const img = useAvatar(url ?? email, request, url !== null);
  const colors = useTheme((s) => s.colors);
  const lane = avatarLane(name, email, colors.graph.length);
  return (
    <span className="avatar" data-testid="avatar" aria-hidden style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: colors.graph[lane], color: colors.laneText[lane] }}>
      {img ? <img src={img.url} alt="" width={size} height={size} /> : initials(name)}
    </span>
  );
}

/** A forge user's avatar (the MR/PR view, the hover card): the picture the forge links to, else
 * the email's (forge first, then Gravatar), else initials. Colours as for the same email. */
export function ForgeAvatar({ user, size }: { user: ForgeUser; size: number }) {
  const url = user.avatarUrl?.trim() || null;
  const email = user.email ?? '';
  return <Avatar name={user.name} email={email} size={size} url={url} request={url !== null || email !== ''} />;
}
