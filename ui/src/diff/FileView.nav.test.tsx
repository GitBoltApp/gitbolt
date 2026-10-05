import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollOf, setPendingScroll, takePendingScroll } from '../nav/scroll';

const host = vi.hoisted(() => ({
  attachFile: vi.fn(), detachFile: vi.fn(), keepFile: vi.fn(() => false), showFile: vi.fn(async () => {}),
  setFileEditable: vi.fn(), onFileEdit: vi.fn(), setFileWordWrap: vi.fn(), releaseDetached: vi.fn(),
  fileScrollTop: vi.fn(() => 75), setFileScrollTop: vi.fn(),
}));
vi.mock('./monaco/load', () => ({ loadMonacoHost: async () => host }));
const { FileView } = await import('./FileView');

const KEY = `file:${'a'.repeat(40)}:docs/a.md`;
beforeEach(() => vi.clearAllMocks());

describe('FileView and navigation places (spec #5 §3.4)', () => {
  it("answers for its place's scroll from the editor, and scrolls back to a pending one after the show", async () => {
    setPendingScroll('', 'file', { key: KEY, view: 'source', top: 480, anchor: null });
    render(<FileView path="docs/a.md" text="# A\n" language="markdown" navKey={KEY} />);
    await waitFor(() => expect(host.setFileScrollTop).toHaveBeenCalledWith(480));
    expect(scrollOf('', 'file', KEY)).toBe(75);
  });

  it('leaves a pending scroll meant for the rendered view to it', async () => {
    setPendingScroll('', 'file', { key: KEY, view: 'rendered', top: 300, anchor: null });
    render(<FileView path="docs/a.md" text="# A\n" language="markdown" navKey={KEY} />);
    await waitFor(() => expect(host.showFile).toHaveBeenCalled());
    expect(host.setFileScrollTop).not.toHaveBeenCalled();
    expect(takePendingScroll('', 'file', KEY, 'rendered')).toMatchObject({ top: 300 });
  });
});
