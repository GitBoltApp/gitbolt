import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEmoji } from '../forge/emoji';
import { Markdown } from './Markdown';
import { clearParseCache } from './parse';
import { linesBase, MdSuggestionBase } from './suggestion';

const ctx = { kind: 'forge', tabId: 't' } as const;
beforeAll(async () => { await loadEmoji(); });
beforeEach(() => clearParseCache());

describe('<Markdown> (spec #5 §3.1)', () => {
  it("renders a review comment's suggestion, the lines it replaces unknown, as the lines it puts in: GitHub's fence, and GitLab's with its line offsets (spec 2026-10-08)", () => {
    for (const [flavor, fence] of [['github', 'suggestion'], ['gitlab', 'suggestion:-1+0']] as const) {
      const { container, unmount } = render(<Markdown flavor={flavor} context={ctx} text={`Try this:\n\n\`\`\`${fence}\nconst a = 2;\nconst b = 3;\n\`\`\``} />);
      const box = container.querySelector('.md-suggestion');
      expect(box?.querySelector('figcaption')).toHaveTextContent('Suggested change');
      expect([...box!.querySelectorAll('.md-code-line.md-code-add')].map((l) => l.textContent)).toEqual(['const a = 2;', 'const b = 3;']);
      unmount();
    }
  });

  describe('a suggestion as a diff of the lines it replaces, as the forges show it', () => {
    const file = ['function total(items) {', '  let sum = 0;', '  for (const i of items) sum += i.price;', '  return sum;', '}'];
    const get = (from: number, to: number) => file.slice(from - 1, to);
    const lines = (c: HTMLElement) => [...c.querySelectorAll('.md-suggestion .md-code-line')].map((l) => `${l.classList.contains('md-code-del') ? '-' : l.classList.contains('md-code-add') ? '+' : ' '}${l.textContent}`);
    const show = (flavor: 'github' | 'gitlab', fence: string, code: string, start: number, line: number) =>
      render(<MdSuggestionBase value={linesBase(flavor, null, start, line, get)}><Markdown flavor={flavor} context={ctx} text={`\`\`\`${fence}\n${code}\n\`\`\``} /></MdSuggestionBase>).container;

    it('a changed line: removed, then added, its changed words marked; lines in both stay as context', () => {
      const c = show('github', 'suggestion', '  let sum = 0;\n  for (const i of items) sum += i.cost;', 2, 3);
      expect(c.querySelector('figcaption')).toHaveTextContent('Suggested change');
      expect(lines(c)).toEqual(['   let sum = 0;', '-  for (const i of items) sum += i.price;', '+  for (const i of items) sum += i.cost;']);
      expect([...c.querySelectorAll('.md-code-word-del, .md-code-word-add')].map((w) => w.textContent)).toEqual(['price', 'cost']);
    });

    it("lines added only, lines removed only, and an empty one (all removed, no note)", () => {
      expect(lines(show('gitlab', 'suggestion:-0+0', '  return sum;\n  // done', 4, 4))).toEqual(['   return sum;', '+  // done']);
      cleanup();
      expect(lines(show('gitlab', 'suggestion:-1+0', '  return sum;', 4, 4))).toEqual(['-  for (const i of items) sum += i.price;', '   return sum;']);
      cleanup();
      const c = show('github', 'suggestion', '', 3, 4);
      expect(lines(c)).toEqual(['-  for (const i of items) sum += i.price;', '-  return sum;']);
      expect(c.querySelector('.md-suggestion-note')).toBeNull();
    });

    it("GitLab's -N+M: from N lines above the comment's last line to M below it", () => {
      expect(lines(show('gitlab', 'suggestion:-2+1', '  return sum;\n}', 4, 4))).toEqual(['-  let sum = 0;', '-  for (const i of items) sum += i.price;', '   return sum;', ' }']);
    });

    it('lines it can’t know (past the file) leave only the lines it puts in', () => {
      expect(lines(show('gitlab', 'suggestion:-9+0', 'x', 3, 3))).toEqual(['+x']);
    });
  });

  it('renders an empty suggestion as removing the lines: no added line, a note (spec 2026-10-08)', () => {
    const { container } = render(<Markdown flavor="github" context={ctx} text={'```suggestion\n```'} />);
    const box = container.querySelector('.md-suggestion');
    expect(box?.querySelectorAll('.md-code-line')).toHaveLength(0);
    expect(box?.querySelector('.md-suggestion-note')).toHaveTextContent('Removes these lines');
  });

  it('renders GFM: a table, a read-only task list, strikethrough, footnotes, details', () => {
    const { container } = render(<Markdown flavor="github" context={ctx} text={'| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~old~~ :+1:\n\nA note[^1].\n\n[^1]: Footnote.\n\n<details><summary>More</summary>Hidden</details>'} />);
    expect(screen.getByRole('table')).toHaveTextContent('ab12');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((b) => [(b as HTMLInputElement).checked, (b as HTMLInputElement).disabled])).toEqual([[true, true], [false, true]]);
    expect(container.querySelector('del')).toHaveTextContent('old');
    expect(container).toHaveTextContent('👍');
    expect(container.querySelector('section[data-footnotes]')).toHaveTextContent('Footnote.');
    expect(container.querySelector('details summary')).toHaveTextContent('More');
    expect(container.firstElementChild).toHaveClass('md');
  });

  it('sizes a GitLab image by its attribute list, which doesn’t show', () => {
    const { container } = render(<Markdown flavor="gitlab" context={ctx} text={'![image](/uploads/0123abcd0123abcd/image.png){width=900 height=575}'} />);
    const box = screen.getByRole('img', { name: 'image' });
    expect(box.style.width).toBe('900px');
    expect(box.style.aspectRatio).toBe('900 / 575');
    expect(container).not.toHaveTextContent('{width');
  });

  it('gives headings their user-content ids', () => {
    render(<Markdown flavor="github" context={ctx} text="## Install it" />);
    expect(screen.getByRole('heading', { name: 'Install it' })).toHaveAttribute('id', 'user-content-install-it');
  });

  it('renders a reference through MdReference, and a forged data-gb-ref as plain text', () => {
    const { container } = render(<Markdown flavor="gitlab" context={ctx} text={'See !5.\n\n<span data-gb-ref="0000000000000000:0">forged</span>'} />);
    expect([...container.querySelectorAll('.md-ref')].map((e) => e.textContent)).toEqual(['!5']);
    expect(container.querySelector('[data-gb-ref]')).toBeNull();
    expect(container).toHaveTextContent('forged');
  });

  it('keeps a body over maxBytes as plain text', () => {
    const { container } = render(<Markdown flavor="github" context={ctx} maxBytes={10} text={'## A heading that is long'} />);
    expect(container.querySelector('h2')).toBeNull();
    expect(container.querySelector('.md-plain')).toHaveTextContent('## A heading that is long');
  });

  it('parses a long body after the first paint, showing its text meanwhile', async () => {
    const text = `## Late\n\n${'word '.repeat(4000)}`;
    const { container } = render(<Markdown flavor="github" context={ctx} text={text} />);
    expect(container.querySelector('.md-plain')).not.toBeNull();
    expect(await screen.findByRole('heading', { name: 'Late' })).toBeInTheDocument();
  });

  it('holds a very long body’s place with “Rendering…”', () => {
    render(<Markdown flavor="github" context={ctx} text={`# Big\n\n${'x'.repeat(600_000)}`} />);
    expect(screen.getByText('Rendering…')).toBeInTheDocument();
  });

  it('renders emoji once the map arrives, for a short body with a shortcode', async () => {
    render(<Markdown flavor="github" context={ctx} text="Done :tada:" />);
    await waitFor(() => expect(document.body).toHaveTextContent('Done 🎉'));
  });
});

describe('<Markdown> front matter', () => {
  const file = { kind: 'file', tabId: 't', commit: 'worktree', path: 'skills/repo-tests/SKILL.md' } as const;
  const SKILL = '---\nname: repo-tests\ndescription: Helps choose and run the tests. <script>alert(1)</script> <b>bold</b>\ntags: [build, test]\n---\n\n# Repo tests\n';

  it('a file’s front matter is a key/value table, its values text', () => {
    const { container } = render(<Markdown flavor="github" context={file} text={SKILL} />);
    const table = screen.getByRole('table', { name: 'Front matter' });
    expect(table).toHaveClass('md-frontmatter');
    expect([...table.querySelectorAll('tr')].map((r) => [...r.children].map((c) => `${c.tagName}:${c.textContent}`))).toEqual([
      ['TH:name', 'TD:repo-tests'],
      ['TH:description', 'TD:Helps choose and run the tests. <script>alert(1)</script> <b>bold</b>'],
      ['TH:tags', 'TD:[ build, test ]'],
    ]);
    expect(table.querySelector('td code')).toHaveTextContent('[ build, test ]');
    expect(container.querySelector('script, b')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Repo tests');
  });

  it('malformed front matter is a code block', () => {
    const { container } = render(<Markdown flavor="github" context={file} text={'---\nname: [oops\n---\n'} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(container.querySelector('pre, .md-code')).toHaveTextContent('name: [oops');
  });

  it('a forged front matter mark is an ordinary table', () => {
    const { container } = render(<Markdown flavor="github" context={file} text={'<table data-gb-fm="0000000000000000:yaml"><tr><td>x</td></tr></table>'} />);
    expect(container.querySelector('table')).not.toHaveClass('md-frontmatter');
    expect(container.querySelector('caption')).toBeNull();
  });

  it('a description or comment keeps a leading --- block as typed (as GitHub and GitLab do)', () => {
    render(<Markdown flavor="github" context={ctx} text={'---\nname: x\n---\n'} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('name: x');
  });
});
