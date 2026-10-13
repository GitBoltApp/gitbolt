// The page's screenshots (spec §6.1 item 3, §6.2): taken by `just site-shots` from the demo build
// into site/shots/<id>.webp (2x) and <id>-1x.webp. One not taken yet shows as the design's glass
// card with its caption, so the page builds either way (the site check warns about it).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { esc, type Marker } from './page.ts';

export type ShotId = 'hero' | 'graph' | 'review' | 'markdown' | 'image' | 'previews' | 'undo' | 'rebase' | 'stack';
/** Alt text, and the 1x file's size in CSS pixels (the 2x file is twice that). */
export interface Shot { alt: string; width: number; height: number }

const FEATURE = { width: 720, height: 450 };
export const SHOTS: Record<ShotId, Shot> = {
  hero: { alt: 'GitBolt with Orbital, a made-up repository: its commit graph, branches and tabs', width: 1240, height: 775 },
  graph: { alt: 'The commit graph with main pinned left, and repository tabs in a tab group', ...FEATURE },
  review: { alt: 'A pending review with a suggested change in the diff', ...FEATURE },
  markdown: { alt: 'A changed devlog page rendered side by side, its changed words highlighted', ...FEATURE },
  image: { alt: 'Swipe view between the old and the redrawn title screen art', ...FEATURE },
  previews: { alt: 'A CSV diff with its changed cells marked', ...FEATURE },
  undo: { alt: 'The undo menu listing the last few operations', ...FEATURE },
  rebase: { alt: 'Interactive rebase with a predicted conflict', ...FEATURE },
  stack: { alt: 'A stack of three merge requests on the graph', ...FEATURE },
};

/** The feature column's width: 7 of 12 columns of the 1,240 px page less the gap, else the page's. */
const FEATURE_SIZES = '(min-width: 1100px) 690px, calc(100vw - 32px)';
/** The hero's frame: the page's width less its 1 px gradient border. */
const HERO_SIZES = '(min-width: 1272px) 1238px, calc(100vw - 34px)';

export const shotExists = (dir: string, id: ShotId): boolean => existsSync(join(dir, `${id}.webp`)) && existsSync(join(dir, `${id}-1x.webp`));

const sources = (id: ShotId) => `src="./shots/${id}-1x.webp" srcset="./shots/${id}-1x.webp ${SHOTS[id].width}w, ./shots/${id}.webp ${SHOTS[id].width * 2}w"`;

export function renderShot(id: ShotId, exists: boolean): string {
  const s = SHOTS[id];
  if (!exists) return `<figure class="shot"><div class="shot-in"><span class="shot-tag">Screenshot</span><span class="shot-cap">${esc(s.alt)}</span></div></figure>`;
  return `<figure class="shot"><div class="shot-in has-img"><img ${sources(id)} sizes="${FEATURE_SIZES}" width="${s.width}" height="${s.height}" alt="${esc(s.alt)}" loading="lazy" decoding="async" /></div></figure>`;
}

export function renderStill(exists: boolean): string {
  const s = SHOTS.hero;
  if (!exists) return '<div class="still still-missing" aria-hidden="true"></div>';
  return `<img class="still" ${sources('hero')} sizes="${HERO_SIZES}" width="${s.width}" height="${s.height}" alt="${esc(s.alt)}" fetchpriority="high" decoding="async" />`;
}

export function heroMarker(shotsDir: string): Marker {
  return (arg) => {
    if (arg !== 'still') throw new Error(`index.html: unknown <!--hero:${arg}-->`);
    return renderStill(shotExists(shotsDir, 'hero'));
  };
}
