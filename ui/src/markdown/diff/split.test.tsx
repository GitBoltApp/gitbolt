import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileMarkdownContext, MdCodeProps, MdImageProps, MdLinkProps } from '../types';

// Which side's context each link and image gets; code and diagrams as their text and line marks.
vi.mock('../MdLink', () => ({ MdLink: ({ ctx, href, children }: MdLinkProps) => <a data-commit={(ctx as { commit: string }).commit} data-href={href}>{children}</a> }));
vi.mock('../MdImage', () => ({ MdImage: ({ ctx, src }: MdImageProps) => <img data-commit={(ctx as { commit: string }).commit} data-src={src} alt="" /> }));
vi.mock('../MdCode', () => ({ MdCode: ({ code, marks }: MdCodeProps) => <pre data-testid="code" data-marks={marks ?? 'none'}>{code}</pre> }));
vi.mock('../MdMermaid', () => ({ MdMermaid: ({ source }: { source: string }) => <pre data-testid="mermaid">{source}</pre> }));
const { MarkdownDiff } = await import('./MarkdownDiff');
const { resetChunkStreams } = await import('../parseAsync');
const { clearParseCache } = await import('../parse');
const { changeTargets, stepChange, STEP_MARGIN } = await import('../../diff/changeStepper');

const NEW: FileMarkdownContext = { kind: 'file', tabId: 't', commit: 'b'.repeat(40), path: 'guide.md' };
const OLD: FileMarkdownContext = { ...NEW, commit: 'a'.repeat(40), path: 'old-guide.md' };
const split = (old: string, neu: string) => render(<MarkdownDiff old={old} new={neu} flavor="github" context={NEW} oldContext={OLD} split />).container;
const rows = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.md-split-row')];
const cells = (row: HTMLElement) => [...row.children] as [HTMLElement, HTMLElement];

afterEach(() => { resetChunkStreams(); clearParseCache(); });

describe('the split rendered diff (5C)', () => {
  it('lines the sides up in rows: unchanged twice, removed and added with placeholders, a changed paragraph with removed words left and added right', () => {
    const c = split('Kept.\n\nGone.\n\nRun the tool once.\n', 'Kept.\n\nRun the tool twice.\n\nNew.\n');
    expect(c.firstElementChild).toHaveClass('md', 'md-diff', 'md-diff-split');
    const [kept, gone, changed, added] = rows(c);
    expect(rows(c)).toHaveLength(4);
    expect(cells(kept!).map((x) => x.textContent)).toEqual(['Kept.', 'Kept.']);
    expect(kept).not.toHaveAttribute('data-diff-mark');

    expect(gone).toHaveAttribute('data-diff-mark', 'removed');
    expect(cells(gone!)[0]).toHaveClass('md-split-old');
    expect(cells(gone!)[0].querySelector('[data-diff-mark="removed"]')).toHaveTextContent('Gone.');
    expect(cells(gone!)[1]).toHaveClass('md-split-empty');
    expect(cells(gone!)[1]).toBeEmptyDOMElement();

    expect(added).toHaveAttribute('data-diff-mark', 'added');
    expect(cells(added!)[0]).toHaveClass('md-split-empty');
    expect(cells(added!)[1].querySelector('[data-diff-mark="added"]')).toHaveTextContent('New.');

    const [left, right] = cells(changed!);
    expect(changed).toHaveAttribute('data-diff-mark', 'changed');
    expect(left).toHaveTextContent('Run the tool once.');
    expect(left.querySelector('del')).toHaveTextContent('once');
    expect(left.querySelector('ins')).toBeNull();
    expect(right).toHaveTextContent('Run the tool twice.');
    expect(right.querySelector('ins')).toHaveTextContent('twice');
    expect(right.querySelector('del')).toBeNull();
  });

  it("resolves the old column's links and images at the old commit, the new column's at the new one", () => {
    const c = split('See [the guide](a.md) and ![logo](logo.png).\n\nOld [x](x.md) text.\n', 'See [the guide](a.md) and ![logo](logo.png).\n\nNew [x](x.md) text.\n');
    for (const row of rows(c)) {
      const [left, right] = cells(row);
      for (const el of left.querySelectorAll('a, img')) expect(el).toHaveAttribute('data-commit', OLD.commit);
      for (const el of right.querySelectorAll('a, img')) expect(el).toHaveAttribute('data-commit', NEW.commit);
    }
    expect(c.querySelectorAll('a')).toHaveLength(4);
  });

  it('a heading keeps its anchor on the new side only', () => {
    const c = split('# Guide\n\nOld.\n', '# Guide\n\nNew.\n');
    const [left, right] = cells(rows(c)[0]!);
    expect(right.querySelector('h1')!.id).toBe('user-content-guide');
    expect(left.querySelector('h1')!.id).not.toBe('user-content-guide');
  });

  it('shows a code block old and new with their line tints, and a diagram old left and new right', () => {
    const c = split('```ts\nconst a = 1;\nconst port = 8080;\n```\n\n```mermaid\ngraph TD\n  A-->B\n```\n', '```ts\nconst a = 1;\nconst port = 9090;\n```\n\n```mermaid\ngraph TD\n  A-->C\n```\n');
    const [code, diagram] = rows(c);
    const [oldCode, newCode] = cells(code!).map((x) => x.querySelector('[data-testid="code"]')!);
    expect(oldCode).toHaveTextContent('const a = 1; const port = 8080;');
    expect(oldCode).toHaveAttribute('data-marks', ' -');
    expect(newCode).toHaveTextContent('const a = 1; const port = 9090;');
    expect(newCode).toHaveAttribute('data-marks', ' +');
    const [oldChart, newChart] = cells(diagram!).map((x) => x.querySelectorAll('[data-testid="mermaid"]'));
    expect(oldChart).toHaveLength(1);
    expect(oldChart![0]).toHaveTextContent('A-->B');
    expect(newChart).toHaveLength(1);
    expect(newChart![0]).toHaveTextContent('A-->C');
    expect(c.querySelector('.md-diff-pair')).toBeNull();
  });

  it('splits a changed list into rows per item, each side with its own numbers and checkboxes', () => {
    const c = split('1. one\n2. two\n3. [ ] three\n', '1. one\n2. inserted\n3. two\n4. [x] three\n');
    const r = rows(c);
    expect(r.map((x) => x.getAttribute('data-diff-mark'))).toEqual([null, 'added', null, 'changed']);
    expect(cells(r[1]!)[0]).toHaveClass('md-split-empty');
    expect(cells(r[2]!).map((x) => x.querySelector('li')!.getAttribute('value'))).toEqual(['2', '3']);
    expect(cells(r[3]!).map((x) => (x.querySelector('input') as HTMLInputElement).checked)).toEqual([false, true]);
    expect(r.slice(0, 3).every((x) => x.classList.contains('md-split-joined'))).toBe(true);
    expect(r[3]).not.toHaveClass('md-split-joined');
  });

  it("keeps a table whole, with a blank placeholder row for a row only the other side has", () => {
    const c = split('| a |\n|---|\n| 1 |\n', '| a |\n|---|\n| 1 |\n| 2 |\n');
    const [left, right] = cells(rows(c)[0]!);
    expect(left.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(left.querySelector('tbody tr:last-child')).toHaveClass('md-split-empty-row');
    expect(right.querySelector('tbody tr:last-child')).toHaveAttribute('data-diff-mark', 'added');
  });

  it('Previous/Next change step through the changed rows', () => {
    const c = split('Alpha.\n\nBeta is here.\n\nGamma.\n\nDelta is here.\n', 'Alpha.\n\nBeta is there.\n\nGamma.\n\nDelta is there.\n');
    const targets = changeTargets(c);
    expect(targets).toEqual(rows(c).filter((r) => r.hasAttribute('data-diff-mark')));
    expect(targets).toHaveLength(2);
    // Lay the rows out 100 px apart, the pane at the top.
    const all = rows(c);
    all.forEach((r, i) => vi.spyOn(r, 'getBoundingClientRect').mockImplementation(() => ({ top: i * 100 - c.scrollTop } as DOMRect)));
    vi.spyOn(c, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
    expect(stepChange(c, 'next')).toBe(true);
    expect(c.scrollTop).toBe(100 - STEP_MARGIN);
    stepChange(c, 'next');
    expect(c.scrollTop).toBe(300 - STEP_MARGIN);
    stepChange(c, 'previous');
    expect(c.scrollTop).toBe(100 - STEP_MARGIN);
  });

  it("a document can't forge a row, a cell, a placeholder or a mark (R17)", async () => {
    const hostile = [
      '<div data-gb-diff="ffffffffffffffff:row:changed" class="md-split-row" data-diff-mark="changed">p</div>',
      '<div data-gb-diff="ffffffffffffffff:old">q</div>',
      '<div data-gb-diff="ffffffffffffffff:empty" class="md-split-empty">r</div>',
      '<table><tr data-gb-diff="ffffffffffffffff:empty"><td>s</td></tr></table>',
      'A <span data-gb-diff="ffffffffffffffff:ins">t</span> <ins>u</ins> <del>w</del>.',
    ].join('\n\n') + '\n';
    const c = split('Before.\n', `Before.\n\n${hostile}`);
    // The real rows: the kept paragraph, then one added row per hostile block (once the emoji
    // map, which `:row:` and the like ask for, has loaded).
    await vi.waitFor(() => expect(rows(c)).toHaveLength(6));
    const r = rows(c);
    expect(c.querySelectorAll('.md-split-empty')).toHaveLength(5);
    expect(c.querySelectorAll('.md-split-empty-row, .md-diff-ins, .md-diff-del, [data-gb-diff]')).toHaveLength(0);
    for (const row of r.slice(1)) {
      expect(row).toHaveAttribute('data-diff-mark', 'added');
      expect(cells(row)[1].querySelectorAll('[data-diff-mark]')).toHaveLength(1);
      expect(cells(row)[1].querySelector('.md-split-row, .md-split-cell')).toBeNull();
    }
    expect(c).toHaveTextContent(/p.*q.*r.*s.*t.*u.*w/s);
  });

  it('a large diff streams in chunks, each chunk its own aligned rows', async () => {
    const big = Array.from({ length: 30 }, (_, i) => `## Part ${i}\n\n${'word '.repeat(400)}`).join('\n\n');
    const c = split(big, big.replace('Part 3', 'Part three'));
    await vi.waitFor(() => expect(c.querySelectorAll('.md-chunk').length).toBeGreaterThan(1), { timeout: 5000 });
    await vi.waitFor(() => expect(screen.queryByText('Rendering…')).toBeNull(), { timeout: 5000 });
    for (const chunk of c.querySelectorAll('.md-chunk')) expect([...chunk.children].every((x) => x.classList.contains('md-split-row'))).toBe(true);
    const changed = c.querySelector('.md-split-row[data-diff-mark="changed"]')!;
    expect(cells(changed as HTMLElement)[0].querySelector('del')).toHaveTextContent('3');
    expect(cells(changed as HTMLElement)[1].querySelector('ins')).toHaveTextContent('three');
  });
});
