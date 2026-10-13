import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaKind } from './kind';
import { canPlay, MediaDiff } from './MediaDiff';
import type { MediaSource } from './sources';

const src = (kind: MediaKind, mime: string, size: number, extra: Partial<MediaSource> = {}): MediaSource => ({ url: `blob:${kind}-${size}`, size, kind, mime, ...(kind === 'font' ? { bytes: new Uint8Array([1, 2, 3]) } : {}), ...extra });

/** jsdom plays nothing: `canPlayType` says yes to `playable` types. */
function playable(...types: string[]) {
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((t: string) => (types.includes(t) ? 'maybe' : ''));
}

const fonts = { add: vi.fn(), delete: vi.fn() };
class FakeFontFace {
  static fail = false;
  family: string;
  constructor(family: string) { this.family = family; }
  load() { return FakeFontFace.fail ? Promise.reject(new Error('bad font')) : Promise.resolve(this); }
}

beforeEach(() => {
  fonts.add.mockClear();
  fonts.delete.mockClear();
  FakeFontFace.fail = false;
  Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MediaDiff', () => {
  it('plays each side of an audio diff with its own player, labelled, with both sizes', () => {
    playable('audio/mpeg');
    const { container } = render(<MediaDiff old={src('audio', 'audio/mpeg', 2048)} new={src('audio', 'audio/mpeg', 3072)} />);
    const players = [...container.querySelectorAll('audio')];
    expect(players.map((a) => [a.getAttribute('src'), a.controls, a.autoplay])).toEqual([['blob:audio-2048', true, false], ['blob:audio-3072', true, false]]);
    expect(screen.getByLabelText('Old audio')).toBe(players[0]);
    expect(screen.getByLabelText('New audio')).toBe(players[1]);
    expect(screen.getByTestId('media-meta')).toHaveTextContent(/^2\.0 KB → 3\.0 KB$/);
    expect(container.querySelector('.side-divider')).not.toBeNull();
  });

  it('an added video shows its one side, unlabelled, never autoplayed', () => {
    playable('video/webm');
    const { container } = render(<MediaDiff old={null} new={src('video', 'video/webm', 100)} single="added" />);
    const video = container.querySelector('video')!;
    expect([video.autoplay, video.preload, video.getAttribute('src')]).toEqual([false, 'metadata', 'blob:video-100']);
    expect(container.querySelectorAll('[data-testid="media-pane"]')).toHaveLength(1);
    expect(container.querySelector('.media-label')).toBeNull();
    expect(screen.getByTestId('media-meta')).toHaveTextContent(/^100 B \(added\)$/);
  });

  it("a paused video's frame shows clear: its controls only while hovered or focused, then from its first play on", () => {
    playable('video/webm');
    render(<MediaDiff old={src('video', 'video/webm', 100)} new={src('video', 'video/webm', 200)} />);
    const video = screen.getByLabelText('New video') as HTMLVideoElement;
    expect(video.controls).toBe(false);
    fireEvent.mouseEnter(video);
    expect(video.controls).toBe(true);
    fireEvent.mouseLeave(video);
    expect(video.controls).toBe(false);
    // From the keyboard: Tab reaches it, and its controls show while it has focus.
    expect(video.tabIndex).toBe(0);
    fireEvent.focus(video);
    expect(video.controls).toBe(true);
    fireEvent.play(video);
    fireEvent.blur(video);
    expect(video.controls).toBe(true);
    expect((screen.getByLabelText('Old video') as HTMLVideoElement).controls).toBe(false);
  });

  it("a format the webview says it can't play shows the note with Open in and Show hex, naming an MP4's codec", () => {
    playable();
    // An MP4 whose sample entry names H.264 (sources.ts reads it).
    const onSourceChange = vi.fn();
    render(<MediaDiff old={null} new={src('video', 'video/mp4', 9, { codec: 'H.264' })} source={<div data-testid="hex">hex</div>} onSourceChange={onSourceChange} openIn={<button type="button">Open in</button>} />);
    expect(screen.getByRole('note')).toHaveTextContent("This video's format (H.264) can't play here");
    expect(screen.getByRole('button', { name: 'Open in' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show hex' }));
    expect(screen.getByTestId('hex')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hex' })).toHaveAttribute('aria-pressed', 'true');
    expect(onSourceChange).toHaveBeenLastCalledWith(true);
  });

  it('both sides unplayable: Open in is offered on the new side only, the version it opens', () => {
    playable();
    render(<MediaDiff old={src('video', 'video/quicktime', 9)} new={src('video', 'video/quicktime', 10)} source={<div />} openIn={<button type="button">Open in</button>} />);
    const [oldPane, newPane] = screen.getAllByTestId('media-pane');
    expect(within(oldPane).queryByRole('button', { name: 'Open in' })).toBeNull();
    expect(within(oldPane).getByRole('button', { name: 'Show hex' })).toBeInTheDocument();
    expect(within(newPane).getByRole('button', { name: 'Open in' })).toBeInTheDocument();
    // No codec named: the container.
    expect(newPane).toHaveTextContent("This video's format (QuickTime) can't play here");
  });

  it("asks canPlayType with the codec an MP4 names, and an element's error falls back to the note", () => {
    playable('video/mp4');
    expect(canPlay('video', 'video/mp4', null)).toBe(true);
    expect(canPlay('video', 'video/mp4', 'H.264')).toBe(false);
    playable('audio/aac');
    const { container } = render(<MediaDiff old={src('audio', 'audio/aac', 10)} new={src('audio', 'audio/aac', 12)} />);
    fireEvent.error(container.querySelectorAll('audio')[1]);
    expect(container.querySelectorAll('audio')).toHaveLength(1);
    expect(screen.getByRole('note')).toHaveTextContent("This audio file's format (AAC) can't play here");
    // No hex view given: no Show hex.
    expect(screen.queryByRole('button', { name: 'Show hex' })).toBeNull();
  });

  it('the Hex toggle swaps the preview for the hex view and back, and reports it', () => {
    playable('audio/ogg');
    const onSourceChange = vi.fn();
    const { container, unmount } = render(<MediaDiff old={null} new={src('audio', 'audio/ogg', 10)} source={<div data-testid="hex">hex</div>} onSourceChange={onSourceChange} />);
    const toggle = screen.getByRole('button', { name: 'Hex' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(screen.getByTestId('hex')).toBeInTheDocument();
    expect(container.querySelector('audio')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('hex')).toBeNull();
    expect(container.querySelector('audio')).not.toBeNull();
    expect(onSourceChange.mock.calls.map((c) => c[0])).toEqual([true, false]);
    unmount();
    expect(onSourceChange).toHaveBeenLastCalledWith(false);
  });

  it("previews a font from its bytes: its name, a pangram at a few sizes and Basic Latin's glyphs, removed when gone", async () => {
    vi.stubGlobal('FontFace', FakeFontFace);
    const { container, unmount } = render(<MediaDiff old={src('font', 'font/ttf', 10)} new={src('font', 'font/woff2', 12)} />);
    await waitFor(() => expect(container.querySelectorAll('.font-sample')).toHaveLength(2));
    const [oldFace, newFace] = fonts.add.mock.calls.map((c) => c[0] as FakeFontFace);
    expect(oldFace.family).not.toBe(newFace.family);
    const sample = container.querySelector<HTMLElement>('.font-sample')!;
    expect(sample.style.fontFamily.replaceAll('"', '')).toBe(oldFace.family); // quoted in jsdom, bare in happy-dom
    expect(sample.querySelectorAll('.font-line')).toHaveLength(5);
    expect(sample).toHaveTextContent('The quick brown fox jumps over the lazy dog');
    const glyphs = screen.getAllByTestId('font-glyphs')[0].children;
    expect([glyphs.length, glyphs[0].textContent, glyphs[glyphs.length - 1].textContent]).toEqual([94, '!', '~']);
    // Not a real font: no name read, its line kept.
    expect(screen.getAllByTestId('font-name')[0].textContent).toBe(' ');
    expect(screen.getByText('Old')).toBeInTheDocument();
    unmount();
    expect(fonts.delete).toHaveBeenCalledTimes(2);
  });

  it("a font the webview can't load says so", async () => {
    vi.stubGlobal('FontFace', FakeFontFace);
    FakeFontFace.fail = true;
    render(<MediaDiff old={null} new={src('font', 'font/otf', 10)} />);
    await act(async () => {});
    expect(screen.getByRole('note')).toHaveTextContent("This font couldn't be loaded");
    expect(fonts.add).not.toHaveBeenCalled();
  });
});
