const DROP = ['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video'];

const outside = (v: string) => !v.trim().startsWith('#');
const cleanCss = (css: string) => css.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*(['"]?)(?!#)[^)]*\1\s*\)/gi, 'none');

/** Mermaid's SVG, sanitized again (spec §6): no script, foreignObject or embedded documents, no
 * event handler, no reference outside the document (`href`, `xlink:href`, CSS `url()`,
 * `@import`); links become their contents. Throws for anything that isn't an SVG. */
export function cleanSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length > 0) throw new Error("the diagram isn't an SVG");
  for (const name of DROP) for (const el of [...root.getElementsByTagName(name)]) el.remove();
  for (const a of [...root.getElementsByTagName('a')]) a.replaceWith(...a.childNodes);
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(attr.name);
      else if ((n === 'href' || n === 'xlink:href' || n === 'src') && outside(attr.value)) el.removeAttribute(attr.name);
      else if (n === 'style') el.setAttribute(attr.name, cleanCss(attr.value));
    }
    if (el.nodeName.toLowerCase() === 'style') el.textContent = cleanCss(el.textContent ?? '');
  }
  return new XMLSerializer().serializeToString(root);
}

type Mermaid = (typeof import('mermaid'))['default'];
let loading: Promise<Mermaid> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

/** Mermaid's own chunk, loaded on the first diagram (a failed load is tried again). */
function mermaidModule(): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default, (e: unknown) => { loading = null; throw e; });
  return loading;
}

/** One diagram at a time (Mermaid keeps global state while it renders), strict, as a clean SVG. */
export function renderMermaid(source: string, dark: boolean): Promise<string> {
  const run = queue.then(async () => {
    const m = await mermaidModule();
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', htmlLabels: false, flowchart: { htmlLabels: false } });
    const id = `gb-mermaid-${++seq}`;
    try {
      const { svg } = await m.render(id, source);
      return cleanSvg(svg);
    } finally {
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = run.catch(() => {});
  return run;
}
