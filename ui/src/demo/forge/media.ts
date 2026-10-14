// Markdown images and videos in MR text (the core's forge/image.rs `media`): an upload of the
// target project is read from the bundle (`forge-uploads/<secret>/<file>`, what the fake's uploads
// list names); any other address asks first and is never fetched: the page has no network.
import type { ForgeImage } from '../../api/gen/ForgeImage';
import type { DemoContext } from '../context';
import { demoRoot } from '../engine/paths';
import { base64 } from '../engine/read/bytes';
import { WEB } from './fakeGitlab';
import { forgeOf, forgeRemotes, mrTarget } from './hub';

// The core's limits (gitvolt-forge http.rs MAX_IMAGE / MAX_VIDEO).
const MAX_IMAGE = 1024 * 1024;
const MAX_VIDEO = 100 * 1024 * 1024;

const starts = (b: Uint8Array, s: string, at = 0) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));

/** avatar_cache `image_ext`, for GitLab's octet-stream uploads: png, jpeg, gif, webp by their bytes; never SVG. */
function imageMime(b: Uint8Array): string | null {
  if (starts(b, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (starts(b, 'GIF87a') || starts(b, 'GIF89a')) return 'image/gif';
  if (starts(b, 'RIFF') && starts(b, 'WEBP', 8)) return 'image/webp';
  return null;
}

/** images.rs `video_mime`, by the first bytes: WebM/Matroska, MP4 (QuickTime's `qt  ` brand apart) or Ogg. */
function videoMime(b: Uint8Array): string | null {
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (b.length >= 12 && starts(b, 'ftyp', 4)) return starts(b, 'qt  ', 8) ? 'video/quicktime' : 'video/mp4';
  if (starts(b, 'OggS')) return 'video/ogg';
  return null;
}

/** image.rs `image_host`: `host[:port]`, lowercased, without userinfo. */
function hostOf(url: string): string {
  const rest = url.trim().split('://').slice(1).join('://') || url.trim();
  const authority = rest.split(/[/?#]/)[0] ?? '';
  return (authority.split('@').pop() ?? authority).toLowerCase();
}

const missing = (reason: string): ForgeImage => ({ kind: 'missing', reason });

export async function forgeMedia(ctx: DemoContext, repo: number, url: string, userAllowed: boolean, video: boolean): Promise<ForgeImage> {
  const u = url.trim();
  const host = hostOf(u);
  // "Load anyway" is a fetch of somebody else's address: the demo has no network.
  if (userAllowed) return missing(`Not in the demo: loading ${host}`);
  const demo = ctx.repos.get(repo);
  const f = await forgeOf(ctx, demo.fs);
  let project: string;
  try {
    project = (await mrTarget(f, await forgeRemotes(ctx, repo))).project.path;
  } catch {
    return { kind: 'ask', host };
  }
  const m = u.startsWith(`${WEB}/`) ? /^(.+)\/uploads\/([0-9a-fA-F]{10,64})\/([^/?#]+)$/.exec(u.slice(WEB.length + 1)) : null;
  if (!m || m[1].toLowerCase() !== project.toLowerCase()) return { kind: 'ask', host };
  const [, , secret, file] = m;
  if (!f.fake.seed.uploads.includes(`${project}/${secret}/${file}`)) return missing('404');
  const name = [...f.projectOf].find(([, p]) => p === project)?.[0];
  let bytes: Uint8Array;
  try {
    bytes = (await demo.fs.promises.readFile(`${demoRoot(name!, 'forge-uploads')}/${secret}/${file}`)) as Uint8Array;
  } catch {
    return missing('404');
  }
  if (bytes.length > (video ? MAX_VIDEO : MAX_IMAGE)) return missing(`larger than ${(video ? MAX_VIDEO : MAX_IMAGE) / (1024 * 1024)} MB`);
  const mime = (video ? videoMime : imageMime)(bytes);
  if (!mime) return missing(video ? 'not a video GitVolt plays (application/octet-stream)' : 'not an image GitVolt shows (application/octet-stream)');
  return { kind: 'found', mime, base64: base64(bytes) };
}
