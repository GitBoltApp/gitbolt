// The page's screenshots (spec §6.1 item 3, §6.2): taken by `just site-shots` from the demo build
// into site/shots/<id>.webp (2x) and <id>-1x.webp. One not taken yet shows as the design's glass
// card with its caption, so the page builds either way (the site check warns about it).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { esc, type Marker } from './page.ts';

export type ShotId = 'hero' | 'review' | 'worktrees' | 'menus' | 'markdown' | 'image' | 'previews' | 'undo' | 'rebase' | 'stack';
/** Alt text, and the 1x file's size in CSS pixels (the 2x file is twice that). A feature shot is
 * the column's 720 px wide, its height that of the part of the window it shows. */
export interface Shot { alt: string; width: number; height: number }

const FEATURE = { width: 720, height: 450 };
/** The diff panel, whole. */
const DIFF = { width: 720, height: 545 };
export const SHOTS: Record<ShotId, Shot> = {
  hero: { alt: 'GitVolt with Orbital, a made-up repository: its commit graph, branches and tabs', width: 1240, height: 775 },
  review: { alt: 'Code review: a pending comment with a suggested change, and a new range being dragged from the gutter', width: 720, height: 400 },
  worktrees: { alt: "Orbital's release worktree switched to, its WIP row above the main worktree's in the graph", ...FEATURE },
  menus: { alt: "A branch's menu: reset modes and merge and rebase rows naming both branches, and the Delete row armed in red, labelled with what a second click does", width: 720, height: 588 },
  markdown: { alt: 'A controls page rendered side by side: table rows removed and added, new sections, changed words highlighted', ...DIFF },
  image: { alt: 'Swipe view between the old and the redrawn title screen art', ...DIFF },
  previews: { alt: "File previews: a CSV diff with its changed cells marked, a PDF's pages side by side, a font's samples, and a video's two versions", width: 720, height: 400 },
  undo: { alt: 'The undo menu listing the last few operations', width: 720, height: 400 },
  rebase: { alt: 'Interactive rebase of a two-branch stack: a commit squashed, a fixup moved under its commit, a typo reworded, and a predicted conflict', width: 720, height: 400 },
  stack: { alt: "A stack of three merge requests: the Stack table in the top one's description, each branch's MR on the graph", width: 720, height: 417 },
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
