import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme/store';
import { THEMES } from '../theme/themes';
import { renderMermaid } from './mermaid';
import { useNearViewport } from './nearViewport';
import type { MdMermaidProps } from './types';

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200);

/** A ```mermaid block (spec §3.1): drawn lazily, strict, shown as an image of the sanitized SVG so
 * nothing in it can run or load (ruling 11). Until then the source shows; on an error it stays,
 * with the error under it. */
export function MdMermaid({ source }: MdMermaidProps) {
  const dark = useTheme((s) => THEMES[s.id].kind === 'dark');
  const box = useRef<HTMLDivElement>(null);
  const near = useNearViewport(box);
  const [state, setState] = useState<{ svg: string } | { error: string } | null>(null);
  useEffect(() => {
    if (!near) return;
    let live = true;
    renderMermaid(source, dark).then((svg) => { if (live) setState({ svg }); }, (e: unknown) => { if (live) setState({ error: reason(e) }); });
    return () => { live = false; };
  }, [source, dark, near]);
  if (state && 'svg' in state) return <div className="md-mermaid" ref={box}><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.svg)}`} alt="Mermaid diagram" /></div>;
  return (
    <div className="md-mermaid" ref={box}>
      <pre className="md-mermaid-source"><code>{source}</code></pre>
      {state && 'error' in state && <p className="md-mermaid-error" role="status">Couldn't draw the diagram: {state.error}</p>}
    </div>
  );
}
