import { Copy } from 'lucide-react';
import { Fragment, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { copyText } from '../api/transport';
import type { CodeTokens } from '../diff/monaco/shiki';
import { useTheme } from '../theme/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useToast } from '../ui/toastStore';
import { queueHighlight } from './highlightQueue';
import { useNearViewport } from './nearViewport';
import { MdContextOverride } from './sideContext';
import type { MdCodeProps } from './types';

/** Longer blocks stay plain: one would hold the main thread too long (ruling 21). */
export const HIGHLIGHT_MAX_CHARS = 16_384;

const style = (t: { color?: string; fontStyle?: number }): CSSProperties => ({
  color: t.color,
  fontStyle: t.fontStyle && t.fontStyle & 1 ? 'italic' : undefined,
  fontWeight: t.fontStyle && t.fontStyle & 2 ? 'bold' : undefined,
  textDecoration: t.fontStyle && t.fontStyle & 4 ? 'underline' : undefined,
});

/** A fenced code block (spec §3.1): Shiki in the loaded editor theme, once the block is near the
 * viewport, through the time-sliced queue; plain for an unknown language or a very long block;
 * Copy on hover, over the block. The text is there from the first paint; highlighting only
 * colours it. */
type Token = CodeTokens['lines'][number][number] | { content: string; color?: undefined; fontStyle?: undefined };

/** A line's word ranges (`start-end`, `,` between them), sorted; malformed ones dropped. */
function rangesOf(entry: string | undefined): [number, number][] {
  if (!entry) return [];
  return entry.split(',').flatMap((r): [number, number][] => {
    const m = /^(\d+)-(\d+)$/.exec(r);
    return m && Number(m[2]) > Number(m[1]) ? [[Number(m[1]), Number(m[2])]] : [];
  }).sort((a, b) => a[0] - b[0]);
}

/** A line's tokens with the characters in `ranges` wrapped in `cls` (5C: a changed line's changed
 * words): each token is cut at the range edges and keeps its own colour. */
function withWords(segs: readonly Token[], ranges: readonly [number, number][], cls: string): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  segs.forEach((t, j) => {
    const end = pos + t.content.length;
    const cuts = new Set([pos, end]);
    for (const [s, e] of ranges) for (const x of [s, e]) if (x > pos && x < end) cuts.add(x);
    const edges = [...cuts].sort((a, b) => a - b);
    for (let k = 0; k + 1 < edges.length; k++) {
      const [a, b] = [edges[k]!, edges[k + 1]!];
      const marked = ranges.some(([s, e]) => a >= s && b <= e);
      out.push(<span key={`${j}:${a}`} style={style(t)} className={marked ? cls : undefined}>{t.content.slice(a - pos, b - pos)}</span>);
    }
    pos = end;
  });
  return out;
}

export function MdCode({ code, lang, marks, words }: MdCodeProps) {
  const theme = useTheme((s) => s.id);
  const box = useRef<HTMLDivElement>(null);
  const near = useNearViewport(box);
  const [tokens, setTokens] = useState<CodeTokens | null>(null);
  useEffect(() => {
    if (!lang || code.length > HIGHLIGHT_MAX_CHARS) { setTokens(null); return; }
    if (!near) return;
    let live = true;
    // The old colours stay until the new theme's arrive: no flash back to plain.
    const job = queueHighlight(code, lang);
    job.result.then((t) => { if (live) setTokens(t); }, () => {});
    return () => { live = false; job.cancel(); };
  }, [code, lang, theme, near]);
  // A changed block (5C) copies its new code: the lines that aren't removed. In the split view's
  // old column (the old side's context), it copies the old code: the lines that aren't added.
  const oldSide = useContext(MdContextOverride) !== null;
  const copied = marks === undefined ? code : code.split('\n').filter((_, i) => marks[i] !== (oldSide ? '+' : '-')).join('\n');
  const copy = () => { copyText(copied).then(() => useToast.getState().show('Copied'), () => useToast.getState().show('Copy failed', { error: true })); };
  const lineClass = (m: string | undefined) => (m === '+' ? 'md-code-line md-code-add' : m === '-' ? 'md-code-line md-code-del' : 'md-code-line');
  const tokenLine = (line: CodeTokens['lines'][number]) => line.map((t, j) => <span key={j} style={style(t)}>{t.content}</span>);
  const lineWords = words?.split(';');
  const markedLine = (i: number, m: string | undefined) => {
    const segs: Token[] = tokens?.lines[i] ?? [{ content: code.split('\n')[i] ?? '' }];
    const ranges = m === '+' || m === '-' ? rangesOf(lineWords?.[i]) : [];
    return ranges.length === 0 ? tokenLine(segs) : withWords(segs, ranges, m === '+' ? 'md-code-word-add' : 'md-code-word-del');
  };
  const body = marks !== undefined
    ? (tokens ? tokens.lines : code.split('\n')).map((_, i) => <span key={i} className={lineClass(marks[i])}>{markedLine(i, marks[i])}</span>)
    : tokens ? tokens.lines.map((line, i) => <Fragment key={i}>{i > 0 && '\n'}{tokenLine(line)}</Fragment>) : code;
  return (
    <div className="md-code" ref={box}>
      <pre data-lang={lang ?? undefined}>
        <code>{body}</code>
      </pre>
      <HoverTooltip content="Copy">
        <button type="button" className="md-copy" aria-label="Copy code" onClick={(e) => { e.stopPropagation(); copy(); }}><Copy size={12} aria-hidden /></button>
      </HoverTooltip>
    </div>
  );
}
