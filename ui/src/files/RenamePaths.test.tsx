import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RenamePaths } from './RenamePaths';

/** Each line as its parts: `~text~` dimmed (common), `[text]` highlighted (changed). */
const marked = (line: Element) =>
  [...line.children].map((p) => (p.classList.contains('rename-common') ? `~${p.textContent}~` : p.classList.contains('rename-changed') ? `[${p.textContent}]` : `?${p.textContent}?`)).join('');

describe('RenamePaths (J15)', () => {
  it('dims what both paths share and highlights what changed, on both lines', () => {
    render(<RenamePaths oldPath="admin/dist/assets/PriceRanges-Dspn_3uo.js" path="admin/dist/assets/PriceRanges-DYuKwOSt.js" />);
    const [oldLine, arrow, newLine] = screen.getByTestId('rename-paths').children;
    expect(oldLine).toHaveTextContent('admin/dist/assets/PriceRanges-Dspn_3uo.js');
    expect(marked(oldLine)).toBe('~admin/dist/assets/PriceRanges-~[Dspn_3uo]~.js~');
    expect(arrow).toHaveTextContent('↓');
    expect(marked(newLine)).toBe('~admin/dist/assets/PriceRanges-~[DYuKwOSt]~.js~');
  });

  it('renders no empty parts: a side with nothing changed is all dimmed', () => {
    render(<RenamePaths oldPath="a/x.ts" path="a/b/x.ts" />);
    const [oldLine, , newLine] = screen.getByTestId('rename-paths').children;
    expect(marked(oldLine)).toBe('~a/~~x.ts~');
    expect(marked(newLine)).toBe('~a/~[b/]~x.ts~');
  });

  it('an image format change says so under the paths; a plain rename or a same-format one does not', () => {
    const { unmount } = render(<RenamePaths oldPath="docs/images/screenshot.png" path="docs/images/screenshot.webp" />);
    expect(screen.getByTestId('format-change')).toHaveTextContent('Format changed: PNG → WebP');
    unmount();
    render(<RenamePaths oldPath="a/x.jpg" path="a/x.jpeg" />);
    expect(screen.queryByTestId('format-change')).toBeNull();
  });
});
