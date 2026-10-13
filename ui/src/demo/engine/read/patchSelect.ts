import type { LineRange } from '../../../api/gen/LineRange';
import type { StageSelection } from '../../../api/gen/StageSelection';
import type { DiffHunk, HunkLine } from './lineDiff';

export type Dir = 'forward' | 'reverse';

const inRanges = (ranges: LineRange[], n: number) => ranges.some((r) => n >= r.start && n <= r.end);

function picked(sel: StageSelection, hunk: number, l: HunkLine): boolean {
  if (sel.kind === 'hunks') return l.kind !== 'context' && sel.hunks.includes(hunk);
  if (l.kind === 'del') return inRanges(sel.old, l.old);
  if (l.kind === 'add') return inRanges(sel.new, l.new);
  return false;
}

/** An unpicked changed line that this direction keeps, as context. */
const becomesContext = (l: HunkLine, pick: boolean, dir: Dir) => !pick && ((l.kind === 'del' && dir === 'forward') || (l.kind === 'add' && dir === 'reverse'));

/** The sides (old, new) a line is on in the patch: none when it's dropped. */
function sides(l: HunkLine, pick: boolean, dir: Dir): [boolean, boolean] {
  if (l.kind === 'context') return [true, true];
  if (pick) return l.kind === 'del' ? [true, false] : [false, true];
  return becomesContext(l, pick, dir) ? [true, true] : [false, false];
}

function bare(text: string): string {
  const t = text.endsWith('\n') ? text.slice(0, -1) : text;
  return t.endsWith('\r') ? t.slice(0, -1) : t;
}

/** `tie_no_eol`: a line without a newline must stay the last of its side; picks grow until it does. */
function tieNoEol(lines: HunkLine[], picks: boolean[], dir: Dir): void {
  for (;;) {
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].noEol) continue;
      const [oldI, newI] = sides(lines[i], picks[i], dir);
      const laterOnSide = (j: number) => {
        const [o, n] = sides(lines[j], picks[j], dir);
        return (oldI && o) || (newI && n);
      };
      let anyLater = false;
      for (let j = i + 1; j < lines.length && !anyLater; j++) anyLater = laterOnSide(j);
      if (!anyLater) continue;
      if (becomesContext(lines[i], picks[i], dir)) {
        picks[i] = true;
        changed = true;
        if (dir === 'forward' && lines[i].kind === 'del') {
          const text = bare(lines[i].text);
          for (let k = i + 1; k < lines.length; k++) {
            if (lines[k].kind === 'add' && !lines[k].noEol && bare(lines[k].text) === text) {
              picks[k] = true;
              break;
            }
          }
        }
      } else {
        for (let j = i + 1; j < lines.length; j++) {
          if (laterOnSide(j) && becomesContext(lines[j], picks[j], dir)) {
            picks[j] = true;
            changed = true;
          }
        }
      }
    }
    if (!changed) return;
  }
}

/** A hunk's picks after the no-newline tie; `null` when the user picked nothing in it. */
function hunkPicks(h: DiffHunk, i: number, sel: StageSelection, dir: Dir): boolean[] | null {
  const picks = h.lines.map((l) => picked(sel, i, l));
  if (!picks.some(Boolean)) return null;
  tieNoEol(h.lines, picks, dir);
  return picks;
}

/** How many hunks have a picked line, and how many changed lines go into the patch in `dir`
 *  (after the no-newline tie, so a label says what's really staged). */
export function selectedLines(hunks: DiffHunk[], sel: StageSelection, dir: Dir): { hunks: number; lines: number } {
  let n = 0;
  let lines = 0;
  hunks.forEach((h, i) => {
    const picks = hunkPicks(h, i, sel, dir);
    if (!picks) return;
    n += 1;
    lines += h.lines.filter((l, k) => picks[k] && l.kind !== 'context').length;
  });
  return { hunks: n, lines };
}
