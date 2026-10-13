// The page's script: the visitor's platform first in the downloads, and the hero's live demo.
import './fonts.css';
import './site.css';
import { armInPlace } from './arm.ts';
import { initFullscreen, initHeroDemo } from './demo-frame.ts';
import { initDownloads } from './downloads.ts';
import { detectOs } from './os.ts';

initDownloads(document, detectOs(navigator));

const hero = document.querySelector<HTMLElement>('.hero-demo');
if (hero) {
  const demo = initHeroDemo(hero);
  const reset = hero.querySelector<HTMLButtonElement>('[data-action="reset"]');
  const full = hero.querySelector<HTMLButtonElement>('[data-action="fullscreen"]');
  const win = hero.querySelector<HTMLElement>('.window');
  // A demo that isn't up has nothing to lose: Reset (or "try again") runs at once.
  if (reset) armInPlace(reset, document, window, () => demo.reset(), () => demo.state === 'ready');
  if (full && win) initFullscreen(full, win, document, () => demo.frame);
}
