import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollOf, setPendingScroll, takePendingScroll } from '../nav/scroll';

const host = vi.hoisted(() => ({
  attachFile: vi.fn(), detachFile: vi.fn(), keepFile: vi.fn(() => false), showFile: vi.fn(async () => {}),
  setFileEditable: vi.fn(), onFileEdit: vi.fn(), setFileWordWrap: vi.fn(), releaseDetached: vi.fn(),
  fileScrollTop: vi.fn(() => 75), setFileScrollTop: vi.fn(), revealFileLines: vi.fn(), fileText: vi.fn((): string | null => null),
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

  it('shows lines asked for selected, over a pending scroll, and again when asked again in the file shown', async () => {
    setPendingScroll('', 'file', { key: KEY, view: 'source', top: 480, anchor: null });
    const at = { side: 'modified' as const, line: 12, end: 20 };
    const { rerender } = render(<FileView identity={KEY} path="docs/a.md" text="# A\n" language="markdown" navKey={KEY} line={at} />);
    await waitFor(() => expect(host.revealFileLines).toHaveBeenCalledWith(12, 20));
    expect(host.setFileScrollTop).not.toHaveBeenCalled();
    host.fileText.mockReturnValue('# A\n');
    rerender(<FileView identity={KEY} path="docs/a.md" text="# A\n" language="markdown" navKey={KEY} line={at} />);
    expect(host.revealFileLines).toHaveBeenCalledTimes(1);
    rerender(<FileView identity={KEY} path="docs/a.md" text="# A\n" language="markdown" navKey={KEY} line={{ side: 'modified', line: 3 }} />);
    await waitFor(() => expect(host.revealFileLines).toHaveBeenLastCalledWith(3, 3));
    expect(host.showFile).toHaveBeenCalledTimes(1);
  });
});
