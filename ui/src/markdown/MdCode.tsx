import { Copy } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react';
import { copyText } from '../api/transport';
import type { CodeTokens } from '../diff/monaco/shiki';
import { useTheme } from '../theme/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useToast } from '../ui/toast';
import { queueHighlight } from './highlightQueue';
import { useNearViewport } from './nearViewport';
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
export function MdCode({ code, lang }: MdCodeProps) {
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
  const copy = () => { copyText(code).then(() => useToast.getState().show('Copied'), () => useToast.getState().show('Copy failed', { error: true })); };
  return (
    <div className="md-code" ref={box}>
      <pre data-lang={lang ?? undefined}>
        <code>{tokens ? tokens.lines.map((line, i) => <Fragment key={i}>{i > 0 && '\n'}{line.map((t, j) => <span key={j} style={style(t)}>{t.content}</span>)}</Fragment>) : code}</code>
      </pre>
      <HoverTooltip content="Copy">
        <button type="button" className="md-copy" aria-label="Copy code" onClick={(e) => { e.stopPropagation(); copy(); }}><Copy size={12} aria-hidden /></button>
      </HoverTooltip>
    </div>
  );
}
