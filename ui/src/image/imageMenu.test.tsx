import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMenu } from '../menu/menuStore';
import type { MenuRow } from '../menu/types';
import { useToast } from '../ui/toast';
import { ImageDiff } from './ImageDiff';
import { imageMenuRows } from './imageMenu';

describe('image context menu (K98)', () => {
  const O = { url: 'blob:old', size: 60 };
  const N = { url: 'blob:new', size: 70 };
  const labels = () => (useMenu.getState().rows ?? []).map((r) => (r.kind === 'action' ? r.label : ''));
  afterEach(() => useMenu.getState().close());

  it('side-by-side: the clicked pane is listed first', () => {
    const { container } = render(<ImageDiff old={O} new={N} />);
    const [oldPane, newPane] = container.querySelectorAll('.image-viewport');
    fireEvent.contextMenu(oldPane);
    expect(labels()).toEqual(['Copy Old Image', 'Copy New Image']);
    fireEvent.contextMenu(newPane);
    expect(labels()).toEqual(['Copy New Image', 'Copy Old Image']);
  });

  it('swipe, onion skin and difference offer old then new', () => {
    const { container } = render(<ImageDiff old={O} new={N} />);
    for (const mode of ['Swipe', 'Onion skin', 'Difference']) {
      fireEvent.click(screen.getByRole('button', { name: mode }));
      fireEvent.contextMenu(container.querySelector('.image-viewport')!);
      expect(labels()).toEqual(['Copy Old Image', 'Copy New Image']);
    }
  });

  it('a single image offers Copy Image', () => {
    const { container } = render(<ImageDiff old={null} new={N} single="added" />);
    fireEvent.contextMenu(container.querySelector('.image-viewport')!);
    expect(labels()).toEqual(['Copy Image']);
  });

  it('each row copies its own side and toasts "Image copied"', async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    const rows = imageMenuRows({ old: O, new: N }, 'new', copy);
    const run = (i: number) => (rows[i] as Extract<MenuRow, { kind: 'action' }>).run();
    run(0);
    expect(copy).toHaveBeenLastCalledWith(N);
    run(1);
    expect(copy).toHaveBeenLastCalledWith(O);
    await waitFor(() => expect(useToast.getState().message).toBe('Image copied'));
  });
});
