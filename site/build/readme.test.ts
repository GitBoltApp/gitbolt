import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { COMPARE_GROUPS, featureSections, GROUP_LANES, HIGHLIGHTS, inline, renderCompare, renderGroups, renderHighlights, type Highlight } from './readme.ts';

const MD = `# Example

## Features

### Highlights

- **Image diffs.** Side by side and swipe,
  all with zoom.
- **Undo history.** A journal of \`git\` operations.

### Everything else

#### Graph and navigation

- **Pinned trunk.** Main stays left.
- **Find.** Search with Ctrl+F; F9 and Shift+F9 step through.

#### Privacy

- **No telemetry,** at all. [PRIVACY.md](PRIVACY.md) has the details.

### Compared with GitKraken

✅ yes, 🟡 partly, ❌ no.

| | GitKraken | GitVolt |
|---|---|---|
| Image diffs | 🟡 | ✅ Side by side, swipe |
| Forges | GitHub, GitLab | GitHub.com and GitLab |
| Git Flow | ✅ | ❌ Not planned |

## Updates

- **Not a feature.** Ignored.
`;

const MINE: Highlight[] = [
  { lead: 'Image diffs', kicker: 'Diffs', lane: 'gold', shot: 'image' },
  { lead: 'Pinned trunk', kicker: 'Graph', lane: 'cyan', shot: 'worktrees' },
];

test("the features' sections and bullets, wrapped lines joined, nothing after ## Features", () => {
  const s = featureSections(MD);
  expect(s.map((x) => [x.level, x.title])).toEqual([[3, 'Highlights'], [3, 'Everything else'], [4, 'Graph and navigation'], [4, 'Privacy'], [3, 'Compared with GitKraken']]);
  expect(s[0].bullets[0]).toEqual({ lead: 'Image diffs.', text: 'Side by side and swipe, all with zoom.' });
  expect(JSON.stringify(s)).not.toContain('Not a feature');
});

test('inline Markdown: code, bold, links into the repository, keys as <kbd>, everything escaped', () => {
  expect(inline('A `git <x>` **bold** & [PRIVACY.md](PRIVACY.md), [Updates](#updates)')).toBe(
    'A <code>git &lt;x&gt;</code> <b>bold</b> &amp; <a href="https://github.com/GitVoltApp/gitvolt/blob/main/PRIVACY.md">PRIVACY.md</a>, <a href="https://github.com/GitVoltApp/gitvolt#updates">Updates</a>',
  );
  expect(inline('Ctrl+F, Ctrl+/, F9 and Shift+F9, not UTF8')).toBe('<kbd>Ctrl</kbd>+<kbd>F</kbd>, <kbd>Ctrl</kbd>+<kbd>/</kbd>, <kbd>F9</kbd> and <kbd>Shift</kbd>+<kbd>F9</kbd>, not UTF8');
});

test('highlights: an article each, alternating sides, kicker, title without its full stop, text and screenshot slot', () => {
  const html = renderHighlights(MD, (id) => id === 'image', MINE);
  expect(html.match(/<article /g)).toHaveLength(2);
  expect(html).toContain('<article class="feat l-gold">');
  expect(html).toContain('<article class="feat rev l-cyan">');
  expect(html).toContain('<p class="kicker"><span class="dot"></span>Diffs</p>');
  expect(html).toContain('<h3>Image diffs</h3>');
  expect(html).toContain('<p>Side by side and swipe, all with zoom.</p>');
  expect(html).toContain('src="./shots/image-1x.webp"');
  expect(html).toContain('<span class="shot-cap">');
});

test('a renamed highlight fails the build, naming HIGHLIGHTS', () => {
  expect(() => renderHighlights(MD, () => false, [{ lead: 'Code review', kicker: 'Review', lane: 'violet', shot: 'review' }])).toThrow(/no bullet "\*\*Code review\.\*\*": update HIGHLIGHTS in site\/build\/readme\.ts/);
});

test('groups: every #### group but Privacy, without the bullets shown as highlights', () => {
  const html = renderGroups(MD, MINE);
  expect(html).toBe('<section class="group glass l-cyan"><h4>Graph and navigation</h4><ul><li><b>Find.</b> Search with <kbd>Ctrl</kbd>+<kbd>F</kbd>; <kbd>F9</kbd> and <kbd>Shift</kbd>+<kbd>F9</kbd> step through.</li></ul></section>');
});

test('a new group needs a lane', () => {
  const md = MD.replace('#### Privacy', '#### Plugins');
  expect(() => renderGroups(md, MINE)).toThrow('README.md\'s group "Plugins" has no lane colour: add it to GROUP_LANES in site/build/readme.ts');
});

const TG = [{ title: 'Diffs', rows: ['Image diffs'] }, { title: 'Other', rows: ['Forges', 'Git Flow'] }];

test('the comparison is grouped: a heading row per group, rows in the group order', () => {
  const html = renderCompare(MD, [{ title: 'Other', rows: ['Git Flow', 'Forges'] }, { title: 'Diffs', rows: ['Image diffs'] }]);
  const seq = [...html.matchAll(/colgroup">([^<]+)<|scope="row">([^<]+)</g)].map((m) => m[1] ?? m[2]);
  expect(seq).toEqual(['Other', 'Git Flow', 'Forges', 'Diffs', 'Image diffs']);
  expect(html).toContain('<tr class="cmp-group"><th colspan="3" scope="colgroup">Other</th></tr>');
});

test('a row in no group, or a group row not in the README, fails', () => {
  expect(() => renderCompare(MD, [{ title: 'Diffs', rows: ['Image diffs'] }])).toThrow('is in no group: add it to COMPARE_GROUPS');
  expect(() => renderCompare(MD, [...TG, { title: 'Ghost', rows: ['Nope'] }])).toThrow('COMPARE_GROUPS\' "Ghost" names a row "Nope"');
});

test('the comparison: marks as pills, notes after them, a cell without a mark as a note', () => {
  const html = renderCompare(MD, TG);
  expect(html).toContain('<th scope="col">GitKraken</th><th scope="col" class="us">GitVolt</th>');
  expect(html).toContain('<tr><th scope="row">Image diffs</th><td data-label="GitKraken"><span class="cv"><span class="m m-partly">Partly</span></span></td><td data-label="GitVolt"><span class="cv"><span class="m m-yes">Yes</span> <span class="m-note">Side by side, swipe</span></span></td></tr>');
  expect(html).toContain('<td data-label="GitKraken"><span class="cv"><span class="m-note">GitHub, GitLab</span></span></td>');
  expect(html).toContain('<span class="m m-no">No</span> <span class="m-note">Not planned</span>');
});

test('a row without three cells fails', () => {
  expect(() => renderCompare(MD.replace('| Git Flow | ✅ | ❌ Not planned |', '| Git Flow | ✅ |'), TG)).toThrow("README.md's comparison table: row 3 has 2 cells, not 3");
});

test('the real README: every highlight and group found, the whole table, links only into this project', () => {
  const md = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const highlights = renderHighlights(md, () => false);
  expect(highlights.match(/<article /g)).toHaveLength(HIGHLIGHTS.length);
  const groups = renderGroups(md);
  expect(groups.match(/<section /g)).toHaveLength(Object.keys(GROUP_LANES).length);
  expect(groups).toContain('<b>Pinned trunk.</b>');
  const rows = md.slice(md.indexOf('### Compared with GitKraken')).split('\n## ')[0].split('\n').filter((l) => l.startsWith('|')).length - 2;
  expect(renderCompare(md).match(/<tr><th scope="row">/g)).toHaveLength(rows);
  expect(COMPARE_GROUPS.flatMap((g) => g.rows)).toHaveLength(rows);
  for (const m of `${highlights}${groups}${renderCompare(md)}`.matchAll(/href="([^"]+)"/g)) expect(m[1]).toMatch(/^https:\/\/github\.com\/GitVoltApp\/gitvolt[/#]/);
});

test("the page's highlights are README.md's, in its order (but the hero's licence line), each lead once in the features", () => {
  const md = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const sections = featureSections(md);
  const leads = sections.find((s) => s.title === 'Highlights')!.bullets.map((b) => b.lead.replace(/[.,:]$/, ''));
  expect(HIGHLIGHTS.map((h) => h.lead)).toEqual(leads.filter((l) => !l.startsWith('Free and MIT licensed')));
  const all = sections.flatMap((s) => s.bullets.map((b) => b.lead.replace(/[.,:]$/, '')));
  for (const h of HIGHLIGHTS) expect(all.filter((l) => l === h.lead), h.lead).toHaveLength(1);
  expect(new Set(HIGHLIGHTS.map((h) => h.shot)).size).toBe(HIGHLIGHTS.length);
});
