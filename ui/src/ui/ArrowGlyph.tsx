import { ArrowLeft, ArrowLeftRight, ArrowRight } from 'lucide-react';
import './arrowGlyph.css';

const TEXT = { right: '→', left: '←', both: '↔' } as const;

/** A visible arrow between two values: an icon, since the UI font's → ← ↔ render tiny. The glyph
 * stays in the DOM, clipped (copy, screen readers, text queries); the icon is what shows. */
export function ArrowGlyph({ dir = 'right' }: { dir?: 'right' | 'left' | 'both' }) {
  const Icon = dir === 'right' ? ArrowRight : dir === 'left' ? ArrowLeft : ArrowLeftRight;
  return <span className="arrow-glyph" data-arrow={dir}><Icon size={12} strokeWidth={2} aria-hidden="true" /><span className="arrow-glyph-text">{TEXT[dir]}</span></span>;
}
