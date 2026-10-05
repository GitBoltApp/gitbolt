const CHUNK = 16_384;

/** A body as written (pre-wrap): too large to render, failed, or not parsed yet. A long one is cut
 * at line ends into chunks the browser skips laying out off-screen (ruling 16). */
export function PlainBody({ text, className }: { text: string; className: string }) {
  if (text.length <= CHUNK * 4) return <div className={`${className} md-plain`}>{text}</div>;
  const parts: string[] = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(text.length, i + CHUNK);
    const nl = text.indexOf('\n', end);
    if (nl >= 0 && nl - end < 2_000) end = nl + 1;
    parts.push(text.slice(i, end));
    i = end;
  }
  return <div className={`${className} md-plain`}>{parts.map((p, i) => <div key={i} className="md-plain-chunk">{p}</div>)}</div>;
}
