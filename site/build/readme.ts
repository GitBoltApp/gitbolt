// The page's feature copy and comparison, from README.md at build time, so the two never drift
// (spec §6.1: the README's Highlights expanded, then the rest grouped; the README's GitKraken table).
// A change to README.md that this can't place fails the build, naming what to update. Node-side only.
import { readFileSync } from 'node:fs';
import { esc, type Marker } from './page.ts';
import { renderShot, shotExists, type ShotId } from './shots.ts';

export type Lane = 'teal' | 'cyan' | 'blue' | 'violet' | 'magenta' | 'pink' | 'orange' | 'gold';
/** A `- **Lead.** text` bullet: its bold lead as written (punctuation kept) and the rest. */
export interface Bullet { lead: string; text: string }
export interface Section { title: string; level: 3 | 4; bullets: Bullet[]; lines: string[] }
export interface Highlight { lead: string; kicker: string; lane: Lane; shot: ShotId }

const REPO = 'https://github.com/GitVoltApp/gitvolt';

/** The page's highlights, in order: README.md's, plus Pinned trunk (from Graph and workspace), as
 * the approved design has them. The README's "Free and MIT licensed" is in the hero. */
export const HIGHLIGHTS: Highlight[] = [
  { lead: 'Pinned trunk', kicker: 'Graph', lane: 'cyan', shot: 'graph' },
  { lead: 'Code review on GitHub and GitLab', kicker: 'Code review', lane: 'violet', shot: 'review' },
  { lead: 'Rendered Markdown diffs', kicker: 'Diffs', lane: 'pink', shot: 'markdown' },
  { lead: 'Image diffs', kicker: 'Diffs', lane: 'gold', shot: 'image' },
  { lead: 'File previews', kicker: 'Previews', lane: 'cyan', shot: 'previews' },
  { lead: 'Undo history', kicker: 'Safety', lane: 'violet', shot: 'undo' },
  { lead: 'Interactive rebase', kicker: 'History', lane: 'pink', shot: 'rebase' },
  { lead: 'Stacked MRs/PRs', kicker: 'Forges', lane: 'gold', shot: 'stack' },
];

/** "Everything else": each README group's lane colour. Privacy has its own section on the page. */
export const GROUP_LANES: Record<string, Lane> = {
  'Graph and workspace': 'cyan',
  'Reviewing and forges': 'violet',
  'History, merges and rebases': 'pink',
  'Files and diffs': 'gold',
  'Keyboard and look': 'cyan',
};
const SKIP_GROUPS = ['Privacy'];

const bare = (lead: string) => lead.replace(/[.,:]$/, '');

/** The `###` and `####` sections of README.md's `## Features`, with their bullets (a wrapped
 * bullet's lines joined) and raw lines (for the table). */
export function featureSections(md: string): Section[] {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Features');
  if (start < 0) throw new Error("README.md has no '## Features' section");
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    const heading = /^(#{3,4}) (.+)$/.exec(line);
    if (heading) {
      current = { title: heading[2].trim(), level: heading[1].length as 3 | 4, bullets: [], lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    const bullet = /^- \*\*(.+?)\*\*\s*(.*)$/.exec(line);
    if (bullet) current.bullets.push({ lead: bullet[1], text: bullet[2] });
    else if (/^ {2}\S/.test(line) && current.bullets.length) {
      const last = current.bullets[current.bullets.length - 1];
      last.text = `${last.text} ${line.trim()}`.trim();
    }
  }
  return sections;
}

const KEYS = /\b(?:(?:Ctrl|Shift|Alt)\+)+(?:F\d{1,2}|[A-Z/])(?!\w)|\bF\d{1,2}\b/g;
const link = (href: string) => (/^https?:\/\//.test(href) ? href : href.startsWith('#') ? `${REPO}${href}` : `${REPO}/blob/main/${href}`);

/** README.md's inline Markdown as HTML: code spans, bold, links (relative ones into the
 * repository on GitHub), and key names as <kbd>. */
export function inline(md: string): string {
  return md.split(/(`[^`]+`)/).map((part) => {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, href: string) => `<a href="${link(href)}">${text}</a>`)
      .replace(KEYS, (k) => k.split('+').map((key) => `<kbd>${key}</kbd>`).join('+'));
  }).join('');
}

function findBullet(sections: Section[], lead: string): Bullet {
  for (const s of sections) for (const b of s.bullets) if (bare(b.lead) === lead) return b;
  throw new Error(`README.md's features have no bullet "**${lead}.**": update HIGHLIGHTS in site/build/readme.ts`);
}

export function renderHighlights(md: string, hasShot: (id: ShotId) => boolean, highlights: Highlight[] = HIGHLIGHTS): string {
  const sections = featureSections(md);
  return highlights.map((h, i) => {
    const b = findBullet(sections, h.lead);
    return `<article class="feat${i % 2 ? ' rev' : ''} l-${h.lane}">
  <div class="feat-text">
    <p class="kicker"><span class="dot"></span>${esc(h.kicker)}</p>
    <h3>${inline(h.lead)}</h3>
    <p>${inline(b.text)}</p>
  </div>
  ${renderShot(h.shot, hasShot(h.shot))}
</article>`;
  }).join('\n');
}

export function renderGroups(md: string, highlights: Highlight[] = HIGHLIGHTS): string {
  const shown = new Set(highlights.map((h) => h.lead));
  return featureSections(md)
    .filter((s) => s.level === 4 && !SKIP_GROUPS.includes(s.title))
    .map((s) => {
      const lane = GROUP_LANES[s.title];
      if (!lane) throw new Error(`README.md's group "${s.title}" has no lane colour: add it to GROUP_LANES in site/build/readme.ts`);
      const items = s.bullets.filter((b) => !shown.has(bare(b.lead))).map((b) => `<li><b>${inline(b.lead)}</b> ${inline(b.text)}</li>`).join('');
      return `<section class="group glass l-${lane}"><h4>${esc(s.title)}</h4><ul>${items}</ul></section>`;
    })
    .join('\n');
}

const MARKS: Array<[mark: string, cls: string, word: string]> = [['✅', 'm-yes', 'Yes'], ['🟡', 'm-partly', 'Partly'], ['❌', 'm-no', 'No']];

export function renderCompare(md: string): string {
  const section = featureSections(md).find((s) => s.title === 'Compared with GitKraken');
  if (!section) throw new Error("README.md has no '### Compared with GitKraken' table");
  const rows = section.lines.filter((l) => l.startsWith('|')).map((l) => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()));
  const [head, , ...body] = rows;
  if (!head || head.length !== 3 || body.length === 0) throw new Error("README.md's comparison table: want a header, a separator and rows of three cells");
  body.forEach((r, i) => {
    if (r.length !== 3) throw new Error(`README.md's comparison table: row ${i + 1} has ${r.length} cells, not 3`);
  });
  const cols = head.slice(1);
  const cell = (text: string, label: string) => {
    const mark = MARKS.find(([m]) => text.startsWith(m));
    const note = mark ? text.slice(mark[0].length).trim() : text;
    const pill = mark ? `<span class="m ${mark[1]}">${mark[2]}</span>` : '';
    const noteHtml = note ? `${pill ? ' ' : ''}<span class="m-note">${inline(note)}</span>` : '';
    return `<td data-label="${esc(label)}"><span class="cv">${pill}${noteHtml}</span></td>`;
  };
  const th = cols.map((c, i) => `<th scope="col"${i === cols.length - 1 ? ' class="us"' : ''}>${esc(c)}</th>`).join('');
  const trs = body.map((r) => `<tr><th scope="row">${inline(r[0])}</th>${cell(r[1], cols[0])}${cell(r[2], cols[1])}</tr>`).join('\n');
  return `<div class="table-wrap glass"><table>\n<thead><tr><td></td>${th}</tr></thead>\n<tbody>${trs}</tbody>\n</table></div>`;
}

export function readmeMarker(readmePath: string, shotsDir: string): Marker {
  return (arg) => {
    const md = readFileSync(readmePath, 'utf8');
    if (arg === 'highlights') return renderHighlights(md, (id) => shotExists(shotsDir, id));
    if (arg === 'groups') return renderGroups(md);
    if (arg === 'compare') return renderCompare(md);
    throw new Error(`index.html: unknown <!--readme:${arg}-->`);
  };
}
