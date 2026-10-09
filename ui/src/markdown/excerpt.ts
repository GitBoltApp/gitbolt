/** How much of a body an excerpt reads: it shows on one line, cut by its box. */
const READ_CHARS = 2_000;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const SUGGESTION = /^suggestion(?::-\d+\+\d+)?$/;

/** One line of Markdown as plain text: no block marks, no inline markup. */
function flattenLine(line: string): string {
  return line
    .replace(/^ {0,3}(?:>\s?)+/, '')
    .replace(/^ {0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '')
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, '$1$2')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/\s*\|\s*/g, ' ');
}

/**
 * A comment's plain-text excerpt (a folded card's one line): its blocks' text, without fences or
 * markup, joined; a suggestion reads "Suggested change". Thematic breaks and blank lines go.
 */
export function plainExcerpt(body: string): string {
  const blocks: string[] = [];
  let para: string[] = [];
  const end = () => { if (para.length) blocks.push(para.join(' ')); para = []; };
  let fence: { mark: string; skip: boolean } | null = null;
  for (const line of body.slice(0, READ_CHARS).split(/\r?\n/)) {
    if (fence) {
      const close = line.trim();
      if (close.startsWith(fence.mark) && /^(`+|~+)$/.test(close) && close[0] === fence.mark[0]) { fence = null; end(); continue; }
      if (!fence.skip && line.trim() !== '') para.push(line.trim());
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      end();
      const suggestion = SUGGESTION.test(f[2] ?? '');
      if (suggestion) blocks.push('Suggested change');
      fence = { mark: f[1]!, skip: suggestion };
      continue;
    }
    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { end(); continue; }
    // A table's delimiter row.
    if (line.includes('|') && /^\s*\|?(?:\s*:?-+:?\s*\|?)+\s*$/.test(line)) continue;
    const text = flattenLine(line).replace(/\s+/g, ' ').trim();
    if (text === '') end();
    else para.push(text);
  }
  end();
  return blocks.join(' · ');
}
