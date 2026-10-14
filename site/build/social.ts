// The page's link previews: the og: and twitter: tags that need the site's absolute address
// (`<!--social:meta-->`), built from GITVOLT_SITE_ORIGIN and GITVOLT_SITE_BASE (docs/website.md).
// The rest of them are plain text in index.html. Scrapers don't resolve relative URLs, hence this.
import { esc, type Marker } from './page.ts';

/** Where the site lives when nothing says otherwise. */
export const SITE_ORIGIN = 'https://gitvolt.com';

/** The image (`just site-og`), in site/public/ so it keeps its name in the build. */
export const OG_IMAGE = {
  file: 'og.jpg',
  width: 1200,
  height: 630,
  alt: "The GitVolt icon and name over the site's lane lines, the line \"A fast, keyboard-friendly desktop Git client\", and the app's commit graph",
};

/** The site's address: `origin` (https and a host, no path) and `base` (the path it's served under). */
export function siteUrl(origin = SITE_ORIGIN, base = '/'): string {
  const o = origin.replace(/\/+$/, '');
  if (!/^https:\/\/[^/?#\s]+$/.test(o)) throw new Error(`GITVOLT_SITE_ORIGIN: "${origin}" isn't a scheme and host, like ${SITE_ORIGIN}`);
  if (!/^\/(?:[^/?#\s]+\/)*$/.test(base)) throw new Error(`GITVOLT_SITE_BASE: "${base}" isn't a path that starts and ends with /`);
  return `${o}${base}`;
}

export function socialTags(url: string): string {
  const image = `${url}${OG_IMAGE.file}`;
  return [
    ['property', 'og:url', url],
    ['property', 'og:image', image],
    ['property', 'og:image:type', 'image/jpeg'],
    ['property', 'og:image:width', String(OG_IMAGE.width)],
    ['property', 'og:image:height', String(OG_IMAGE.height)],
    ['property', 'og:image:alt', OG_IMAGE.alt],
    ['name', 'twitter:image', image],
    ['name', 'twitter:image:alt', OG_IMAGE.alt],
  ].map(([key, name, value]) => `<meta ${key}="${name}" content="${esc(value)}" />`).join('\n    ');
}

export function socialMarker(origin?: string, base?: string): Marker {
  const url = siteUrl(origin || SITE_ORIGIN, base || '/');
  return (arg) => {
    if (arg !== 'meta') throw new Error(`index.html: unknown <!--social:${arg}-->`);
    return socialTags(url);
  };
}
