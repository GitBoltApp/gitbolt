import { useEffect, useMemo, useState, useSyncExternalStore, type JSX } from 'react';
import { emojiReady, loadEmoji } from '../../forge/emoji';
import { textKey } from '../../util/textHash';
import { SYNC_PARSE_CHARS } from '../limits';
import { Boundary, StreamBody, wantsEmoji, Whole } from '../Markdown';
import { diffChunkStream } from '../parseAsync';
import { PlainBody } from '../PlainBody';
import type { FileMarkdownContext, MdFlavor } from '../types';
import { diffMarkdown } from './diffTree';
import '../markdown.css';

/** R5: shown above a diff in which nothing renders differently. */
export const NO_RENDERED_CHANGES = 'Nothing changed in the rendered text: only whitespace or Markdown formatting. Source shows the edit.';

export interface MarkdownDiffProps {
  /** The old text; `''` for an added file (R6). */
  old: string;
  /** The new text; `''` for a deleted file. */
  new: string;
  flavor: MdFlavor;
  /** The new side: what everything but removed parts resolves against. */
  context: FileMarkdownContext;
  /** The old side (R9): its commit and path. */
  oldContext: FileMarkdownContext;
  className?: string;
  /** R14: the diff gave up (its alignment ran out of time, or the main thread was left with a
   * text too long for it). Diff View falls back to Source with "Too large to render"; meanwhile
   * the pane shows nothing. Without it, the new text shows as written with that note. */
  onTooLarge?: () => void;
}

function NoChanges() {
  return <p role="note" className="md-diff-none">{NO_RENDERED_CHANGES}</p>;
}

type Inner = { old: string; neu: string; flavor: MdFlavor; context: FileMarkdownContext; oldContext: FileMarkdownContext; className: string; onTooLarge?: () => void };

/** Calls `onTooLarge` once `tooLarge` holds. */
function useTooLarge(tooLarge: boolean, onTooLarge: (() => void) | undefined): void {
  useEffect(() => { if (tooLarge) onTooLarge?.(); }, [tooLarge, onTooLarge]);
}

function TooLarge({ text, className }: { text: string; className: string }) {
  return <><PlainBody text={text} className={className} /><p className="md-error">Too large to render</p></>;
}

/** A large diff: aligned in the worker, rendered chunk by chunk (5A's `StreamBody`). */
function Streamed({ old, neu, flavor, context, oldContext, className, onTooLarge }: Inner) {
  const stream = useMemo(() => diffChunkStream(old, neu, flavor), [old, neu, flavor]);
  useSyncExternalStore(stream.subscribe, () => stream.version);
  useTooLarge(stream.tooLarge, onTooLarge);
  if (stream.tooLarge && onTooLarge) return null;
  const none = stream.done && !stream.failed && stream.chunks[0]?.data?.gbChanges === 0;
  return <>{none && <NoChanges />}<StreamBody stream={stream} text={neu} context={context} old={oldContext} className={className} /></>;
}

function Rendered({ old, neu, flavor, context, oldContext, className, onTooLarge }: Inner) {
  const needsEmoji = wantsEmoji(old) || wantsEmoji(neu);
  const [emojiTried, setEmojiTried] = useState(false);
  useEffect(() => {
    if (needsEmoji) void loadEmoji().finally(() => setEmojiTried(true));
  }, [needsEmoji]);
  const small = old.length + neu.length <= SYNC_PARSE_CHARS;
  const wait = needsEmoji && !emojiTried;
  const emoji = emojiReady();
  const result = useMemo(
    () => (small && !wait ? diffMarkdown(old, neu, flavor) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `emoji` changes what the parse gives
    [old, neu, flavor, small, wait, emoji],
  );
  useTooLarge(result?.gaveUp === true, onTooLarge);
  // A hash of the texts, once per text: a key holding them would rebuild megabytes each render.
  const streamKey = useMemo(() => (small ? '' : `${flavor}\0${textKey(old)}\0${textKey(neu)}`), [old, neu, flavor, small]);
  if (!small) return <Streamed key={streamKey} old={old} neu={neu} flavor={flavor} context={context} oldContext={oldContext} className={className} onTooLarge={onTooLarge} />;
  if (!result) return <PlainBody text={neu} className={className} />;
  if (result.gaveUp) return onTooLarge ? null : <TooLarge text={neu} className={className} />;
  return <>{result.changes === 0 && <NoChanges />}<Whole tree={result.root} context={context} old={oldContext} className={className} /></>;
}

/**
 * The rendered Markdown diff (5C, R1): `old` and `new` lined up block by block in one column, with
 * the changes marked. It renders through 5A's pipeline (sanitized, React elements, never an HTML
 * string). A small diff renders in the first paint; a large one in the worker, progressively. A
 * failure shows the new text with "Couldn't render" (5A's boundary). Size limits are the caller's
 * (R14: `DiffTextBody`), told of a diff that gave up through `onTooLarge`.
 */
export function MarkdownDiff({ old, new: neu, flavor, context, oldContext, className, onTooLarge }: MarkdownDiffProps): JSX.Element {
  const cls = className ? `md md-diff ${className}` : 'md md-diff';
  return <Boundary text={neu} className={cls}><Rendered old={old} neu={neu} flavor={flavor} context={context} oldContext={oldContext} className={cls} onTooLarge={onTooLarge} /></Boundary>;
}
