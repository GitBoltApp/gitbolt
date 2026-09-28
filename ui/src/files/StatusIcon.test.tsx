import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STATUS_COLOR, StatusIcon, statusKind } from './StatusIcon';

describe('StatusIcon', () => {
  it('maps git status letters to the four kinds (plus conflicted)', () => {
    expect(['A', 'C', 'M', 'T', 'D', 'R', 'U', 'X'].map(statusKind)).toEqual(['added', 'added', 'modified', 'modified', 'deleted', 'renamed', 'conflicted', 'conflicted']);
  });

  it('colours each kind from the status tokens', () => {
    expect(STATUS_COLOR).toEqual({
      added: 'var(--status-added)',
      modified: 'var(--status-modified)',
      deleted: 'var(--status-deleted)',
      renamed: 'var(--status-renamed)',
      conflicted: 'var(--status-conflicted)',
    });
  });

  it('draws an inline SVG per kind, named by the git status, with no letter', () => {
    render(<>{['A', 'M', 'D', 'R', 'C'].map((s) => <StatusIcon key={s} status={s} />)}</>);
    const icons = screen.getAllByRole('img');
    expect(icons.map((i) => i.getAttribute('aria-label'))).toEqual(['Added', 'Modified', 'Deleted', 'Renamed', 'Copied']);
    expect(icons.map((i) => i.getAttribute('data-status'))).toEqual(['added', 'modified', 'deleted', 'renamed', 'added']);
    expect(icons.every((i) => i.tagName.toLowerCase() === 'svg' && i.textContent === i.getAttribute('aria-label'))).toBe(true); // only the <title>
    expect(icons[1]).toHaveStyle({ color: 'var(--status-modified)' });
    // Distinct glyphs: no two kinds share a drawing.
    const shapes = icons.slice(0, 4).map((i) => i.innerHTML.replace(/<title>.*<\/title>/, ''));
    expect(new Set(shapes).size).toBe(4);
  });

  it('accepts a kind name, and is hidden from assistive tech when decorative', () => {
    const { container } = render(<StatusIcon status="renamed" size={10} decorative />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('data-status', 'renamed');
    expect(svg).toHaveAttribute('width', '10');
    expect(screen.queryByRole('img')).toBeNull();
  });
});
