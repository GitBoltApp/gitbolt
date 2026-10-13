// The visitor's platform first in the downloads, marked "Your system", and named in the header's
// Download (which goes to the downloads). Without a known platform the page stays as built.
import type { Os } from './os.ts';

const NAMES: Record<Os, string> = { linux: 'Linux', macos: 'macOS', windows: 'Windows' };

export function initDownloads(doc: Document, os: Os | null): void {
  if (!os) return;
  const card = doc.querySelector<HTMLElement>(`.dl[data-os="${os}"]`);
  if (card) {
    card.classList.add('you');
    card.querySelector('.youtag')?.removeAttribute('hidden');
    card.parentElement?.prepend(card);
  }
  const label = doc.querySelector('.cta .cta-os');
  if (label) label.textContent = `for ${NAMES[os]}`;
}
