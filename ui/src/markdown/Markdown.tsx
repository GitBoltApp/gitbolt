import type { Root } from 'mdast';
import { Component, memo, useEffect, useMemo, useState, useSyncExternalStore, type ErrorInfo, type JSX, type ReactNode } from 'react';
import { emojiReady, HAS_SHORTCODE, loadEmoji } from '../forge/emoji';
import { whenIdle } from './idle';
import { chunkHeightOf } from './chunks';
import { DEFAULT_MAX_BYTES, overBytes, RENDERING_NOTE_CHARS, SYNC_PARSE_CHARS } from './limits';
import { parseMarkdown, peekParsed } from './parse';
import { chunkStream } from './parseAsync';
import { PlainBody } from './PlainBody';
import { renderTree } from './render';
import type { MarkdownContext, MarkdownProps, MdFlavor } from './types';
import './markdown.css';

export { whenIdle };
export const wantsEmoji = (text: string) => !emojiReady() && HAS_SHORTCODE.test(text);
export const contextKey = (c: MarkdownContext) => (c.kind === 'forge' ? `forge\0${c.tabId}` : `file\0${c.tabId}\0${c.commit}\0${c.path}`);

function Failed({ text, className }: { text: string; className: string }) {
  return <><PlainBody text={text} className={className} /><p className="md-error">Couldn't render</p></>;
}

const FAILED = '\0failed';

/** One body's error boundary: a throw shows that body as plain text; the next text tries again. */
class Boundary extends Component<{ text: string; className: string; children: ReactNode }, { failedText: string | null }> {
  state = { failedText: null as string | null };
  static getDerivedStateFromError() { return { failedText: FAILED }; }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.warn('Markdown render failed:', error.message);
    this.setState({ failedText: this.props.text });
  }
  render() {
    const f = this.state.failedText;
    return f !== null && (f === FAILED || f === this.props.text) ? <Failed text={this.props.text} className={this.props.className} /> : this.props.children;
  }
}

/** A small or cached body, rendered whole in the first paint. */
function Whole({ tree, context, className }: { tree: Root; context: MarkdownContext; className: string }) {
  const ctxKey = contextKey(context);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the context's value
  const body = useMemo(() => renderTree(tree, context), [tree, ctxKey]);
  return <div className={className}>{body}</div>;
}

/** One chunk of a large document: converted once, never re-rendered by the next chunk's arrival.
 * Until the browser lays it out, it holds a height estimated from its source length. */
const Chunk = memo(function Chunk({ tree, context }: { tree: Root; context: MarkdownContext }) {
  const ctxKey = contextKey(context);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the context's value
  const body = useMemo(() => renderTree(tree, context), [tree, ctxKey]);
  return <div className="md-chunk" style={{ containIntrinsicSize: `auto ${chunkHeightOf(tree)}px` }}>{body}</div>;
}, (a, b) => a.tree === b.tree && contextKey(a.context) === contextKey(b.context));

/** A large body (ruling 21): parsed in the worker, then one more chunk per idle callback. Its
 * text (or "Rendering…") holds the place until the first chunk; "Rendering…" follows the last
 * rendered chunk until the end. */
function Progressive({ text, flavor, context, className }: { text: string; flavor: MdFlavor; context: MarkdownContext; className: string }) {
  const stream = useMemo(() => chunkStream(text, flavor), [text, flavor]);
  useSyncExternalStore(stream.subscribe, () => stream.version);
  const [count, setCount] = useState(0);
  const total = stream.chunks.length;
  // The first chunk renders with the message that brought it (one chunk per task either way).
  const shown = Math.max(count, Math.min(total, 1));
  useEffect(() => {
    if (shown >= total) return;
    return whenIdle(() => setCount(Math.min(shown + 1, stream.chunks.length)));
  }, [shown, total, stream]);
  if (stream.tooLarge) return <><PlainBody text={text} className={className} /><p className="md-error">Too large to render</p></>;
  if (stream.failed) return <Failed text={text} className={className} />;
  if (shown === 0) return text.length > RENDERING_NOTE_CHARS ? <div className={className}><p className="md-rendering">Rendering…</p></div> : <PlainBody text={text} className={className} />;
  return (
    <div className={className}>
      {stream.chunks.slice(0, shown).map((c, i) => <Chunk key={i} tree={c} context={context} />)}
      {(!stream.done || shown < total) && <p className="md-rendering">Rendering…</p>}
    </div>
  );
}

function Rendered({ text, flavor, context, className }: { text: string; flavor: MdFlavor; context: MarkdownContext; className: string }) {
  const needsEmoji = wantsEmoji(text);
  const [emojiTried, setEmojiTried] = useState(false);
  useEffect(() => {
    if (needsEmoji) void loadEmoji().finally(() => setEmojiTried(true));
  }, [needsEmoji]);
  const small = text.length <= SYNC_PARSE_CHARS;
  // A short body with shortcodes waits (as plain text) for the emoji map, once.
  const waitEmoji = needsEmoji && !emojiTried;
  const emoji = emojiReady();
  // Kept with the body: a re-render (a poll tick) never parses again, even once the shared LRU
  // has moved on (a PR with more bodies than it holds).
  const tree = useMemo(
    () => (!small ? null : peekParsed(text, flavor) ?? (waitEmoji ? null : parseMarkdown(text, flavor))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `emoji` changes what the parse gives
    [text, flavor, small, waitEmoji, emoji],
  );
  if (small) return tree ? <Whole tree={tree} context={context} className={className} /> : <PlainBody text={text} className={className} />;
  // Long bodies always stream (their chunks are kept by `chunkStream`, not the parse LRU).
  return <Progressive key={`${flavor}\0${text}`} text={text} flavor={flavor} context={context} className={className} />;
}

/** Rendered Markdown (spec §3.1): plain text over `maxBytes`; a body that fails shows as plain
 * text with "Couldn't render", alone. */
export function Markdown({ text, flavor, context, maxBytes = DEFAULT_MAX_BYTES, className }: MarkdownProps): JSX.Element {
  const cls = className ? `md ${className}` : 'md';
  if (overBytes(text, maxBytes)) return <PlainBody text={text} className={cls} />;
  return <Boundary text={text} className={cls}><Rendered text={text} flavor={flavor} context={context} className={cls} /></Boundary>;
}
