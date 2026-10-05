import { useState } from 'react';
import type { ForgeUser } from '../api/gen/ForgeUser';
import { initials } from '../format/initials';
import { useTheme } from '../theme/store';
import { isDecoded, markDecoded, useAvatar } from './avatarStore';
import { avatarLane } from './color';
import './avatar.css';

/** A person's avatar: initials on a lane-palette colour picked by the email, replaced by the
 * image once it has loaded. An image already known to load (decoded on arrival, or loaded by any
 * other `Avatar`: the graph's, the previous commit's) shows at once, with no initials frame. Any
 * other waits invisibly over the initials; one that fails to load (bytes the browser can't decode)
 * is dropped and the initials stay: never a broken-image icon. One image per person whatever the
 * `size` (CSS scales it). Decorative: the name is always shown next to it (or in a tooltip). `request: false`: never
 * asks for the image itself (useAvatar). `url`: a forge user's picture (`ForgeAvatar`), fetched by
 * the backend instead of the email's. The graph's commit nodes draw the same avatar on the canvas
 * (graph/draw.ts), with the same `avatarLane`. */
export function Avatar({ name, email, size = 24, request = true, url = null }: { name: string; email: string; size?: number; request?: boolean; url?: string | null }) {
  const img = useAvatar(url ?? email, request, url !== null);
  const colors = useTheme((s) => s.colors);
  const lane = avatarLane(name, email, colors.graph.length);
  // How the current image went, keyed by its src (a new image starts over): loaded, or failed.
  const [outcome, setOutcome] = useState<{ src: string; ok: boolean } | null>(null);
  const src = img?.url ?? null;
  const done = src === null ? null : outcome?.src === src ? outcome.ok : isDecoded(src) || null;
  return (
    <span className="avatar" data-testid="avatar" aria-hidden style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: colors.graph[lane], color: colors.laneText[lane] }}>
      {done !== true && initials(name)}
      {src && done !== false && (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          data-loading={done === null || undefined}
          onLoad={() => {
            markDecoded(src);
            setOutcome({ src, ok: true });
          }}
          onError={() => setOutcome({ src, ok: false })}
        />
      )}
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
