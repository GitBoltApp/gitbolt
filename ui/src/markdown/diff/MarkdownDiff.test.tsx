import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileMarkdownContext } from '../types';

// Diagrams draw through a stub (MdMermaid's own tests cover Mermaid); code stays plain.
vi.mock('../mermaid', () => ({ renderMermaid: async (s: string) => `<svg xmlns="http://www.w3.org/2000/svg"><text>${s.length}</text></svg>` }));
vi.mock('../highlightQueue', () => ({ queueHighlight: () => ({ result: Promise.resolve(null), cancel: () => {} }) }));
const { MarkdownDiff } = await import('./MarkdownDiff');
const { resetChunkStreams } = await import('../parseAsync');
const { clearParseCache } = await import('../parse');

const NEW: FileMarkdownContext = { kind: 'file', tabId: 't', commit: 'b'.repeat(40), path: 'guide.md' };
const OLD: FileMarkdownContext = { ...NEW, commit: 'a'.repeat(40) };
const v1 = '# Setup guide\n\nRun the tool once.\n\n- install\n\n```ts\nconst port = 8080;\n```\n\n```mermaid\ngraph TD\n  A-->B\n```\n';
const v2 = '# Install guide\n\nRun the tool twice.\n\n- install\n- verify\n\n```ts\nconst port = 9090;\n```\n\n```mermaid\ngraph TD\n  A-->C\n```\n';

afterEach(() => { resetChunkStreams(); clearParseCache(); });

describe('<MarkdownDiff> (5C)', () => {
  it('renders a small diff in the first paint: words, an added item, code lines, diagrams side by side', async () => {
    const { container } = render(<MarkdownDiff old={v1} new={v2} flavor="github" context={NEW} oldContext={OLD} />);
    expect(container.firstElementChild).toHaveClass('md', 'md-diff');
    expect(container.querySelector('h1 del')).toHaveTextContent('Setup');
    expect(container.querySelector('h1 ins')).toHaveTextContent('Install');
    expect(container.querySelector('p del')).toHaveTextContent('once');
    expect(container.querySelector('p ins')).toHaveTextContent('twice');
    expect(container.querySelector('li[data-diff-mark="added"]')).toHaveTextContent('verify');
    expect([...container.querySelectorAll('.md-code-line')].map((l) => l.className)).toEqual(['md-code-line md-code-del', 'md-code-line md-code-add']);
    await waitFor(() => expect(container.querySelectorAll('.md-diff-pair img')).toHaveLength(2));
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('nothing changed in the rendered text: the document, unmarked, with no notice', () => {
    const { container } = render(<MarkdownDiff old={'Some  text\nhere.\n'} new={'Some text here.\n'} flavor="github" context={NEW} oldContext={OLD} />);
    expect(container).toHaveTextContent('Some text here.');
    expect(container.querySelector('[data-diff-mark]')).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('an LF to CRLF change marks nothing removed or added', () => {
    const { container } = render(<MarkdownDiff old={v1} new={v1.replace(/\n/g, '\r\n')} flavor="github" context={NEW} oldContext={OLD} />);
    expect(container.querySelector('[data-diff-mark]')).toBeNull();
  });

  it('a changed task item: the checkbox inline with its text, the tight list kept tight, one mark', () => {
    const { container } = render(<MarkdownDiff old={'- [ ] Write docs\n- [x] Ship\n'} new={'- [ ] Write the docs\n- [x] Ship\n'} flavor="github" context={NEW} oldContext={OLD} />);
    const li = container.querySelector('li[data-diff-mark="changed"]')!;
    expect(li.firstElementChild?.tagName).toBe('INPUT');
    expect(li.querySelector('ins')).toHaveTextContent('the');
    expect(container.querySelector('li p, li div')).toBeNull();
    expect(container.querySelectorAll('[data-diff-mark]')).toHaveLength(1);
  });

  describe('changes outside the blocks: definitions, start numbers, alignment', () => {
    const show = (old: string, neu: string) => render(<MarkdownDiff old={old} new={neu} flavor="github" context={NEW} oldContext={OLD} />).container;

    it("a footnote's changed text is marked in the footnotes", () => {
      const c = show('Text.[^1]\n\n[^1]: The old note.\n', 'Text.[^1]\n\n[^1]: The new note.\n');
      const fn = c.querySelector('section[data-footnotes]')!;
      expect(fn.querySelector('[data-diff-mark="changed"] del')).toHaveTextContent('old');
      expect(fn.querySelector('[data-diff-mark="changed"] ins')).toHaveTextContent('new');
    });

    it('an added and a removed footnote are marked in the footnotes', () => {
      let c = show('Text.\n', 'Text.[^n]\n\n[^n]: A note.\n');
      expect(c.querySelector('section[data-footnotes] [data-diff-mark="added"]')).toHaveTextContent('A note.');
      cleanup();
      c = show('Gone.[^n]\n\n[^n]: A note.\n', 'Other text.\n');
      expect(c.querySelector('section[data-footnotes] [data-diff-mark="removed"]')).toHaveTextContent('A note.');
    });

    it("a list's start number shows a marked list with a note", () => {
      const c = show('3. alpha\n4. beta\n', '5. alpha\n6. beta\n');
      expect(c.querySelector('[data-diff-mark="changed"] .md-diff-note')).toHaveTextContent('Start number changed');
      expect(c.querySelector('[data-diff-mark="changed"] ol')).toHaveAttribute('start', '5');
    });

    it("a link definition's changed URL marks its uses: the old link removed, the new one added", () => {
      const c = show('See [the docs][d].\n\n[d]: https://docs.example/old\n', 'See [the docs][d].\n\n[d]: https://docs.example/new\n');
      // Links render without href (ruling 12): their targets are checked in diffTree.test.
      expect(c.querySelector('del a.md-link')).toHaveTextContent('the docs');
      expect(c.querySelector('ins a.md-link')).toHaveTextContent('the docs');
    });

    it("a document's own data-gb-note never shows as a note", () => {
      const c = show('Old.\n', 'New.\n\n<div data-gb-note="forged">x</div>\n');
      expect(c.querySelector('.md-diff-note')).toBeNull();
    });
  });

  it("a removed HTML block's stray closing tag can't close its mark: it stays entirely marked", () => {
    const { container } = render(<MarkdownDiff old={'Keep.\n\n</div>\n<p>Old stuff</p>\n\nAfter.\n'} new={'Keep.\n\nAfter.\n'} flavor="github" context={NEW} oldContext={OLD} />);
    const removed = container.querySelector('[data-diff-mark="removed"]')!;
    expect(removed).toHaveTextContent('Old stuff');
    expect([...container.querySelectorAll('p')].filter((p) => p.textContent === 'Old stuff' && !removed.contains(p))).toHaveLength(0);
  });

  it('Previous/Next change stop at each counted change (R3)', async () => {
    const { changeTargets } = await import('../../diff/changeStepper');
    const { diffMarkdown } = await import('./diffTree');
    const old = `${v1}\n| a | b |\n|---|---|\n| 1 | 2 |\n\nText.[^1]\n\n[^1]: The old note.\n\n<div>\nOld HTML.\n</div>\n`;
    const neu = `${v2}\n| a | b |\n|---|---|\n| 1 | 3 |\n\nText.[^1]\n\n[^1]: The new note.\n\n<div>\nNew HTML.\n</div>\n`;
    const { container } = render(<MarkdownDiff old={old} new={neu} flavor="github" context={NEW} oldContext={OLD} />);
    const changes = diffMarkdown(old, neu, 'github').changes;
    expect(changes).toBe(9);
    expect(changeTargets(container as HTMLElement)).toHaveLength(changes);
  });

  it('an added file renders all added (R6)', () => {
    render(<MarkdownDiff old="" new={'# A\n\nB.\n'} flavor="github" context={NEW} oldContext={OLD} />);
    expect(screen.getAllByRole('group', { name: 'Added' })).toHaveLength(2);
  });

  it("a large diff streams in chunks through 5A's progressive renderer", async () => {
    const big = Array.from({ length: 30 }, (_, i) => `## Part ${i}\n\n${'word '.repeat(400)}`).join('\n\n');
    const { container } = render(<MarkdownDiff old={big} new={big.replace('Part 3', 'Part three')} flavor="github" context={NEW} oldContext={OLD} />);
    // The main-thread diff of two 60 K texts, then one chunk per idle callback: ~0.3 s alone, over
    // 1 s with the full suite in parallel.
    await waitFor(() => expect(container.querySelectorAll('.md-chunk').length).toBeGreaterThan(1), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByText('Rendering…')).toBeNull(), { timeout: 5000 });
    expect(screen.getByRole('group', { name: 'Changed' })).toHaveTextContent('Part 3three');
  });

  describe('a diff that runs out of time (R14)', () => {
    afterEach(() => vi.restoreAllMocks());
    /** A clock that moves 1 s on every read: any diff runs past its deadline. */
    const slowClock = () => { let t = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000)); };

    it('a small one (main thread, first paint) calls onTooLarge and shows nothing', async () => {
      slowClock();
      const onTooLarge = vi.fn();
      const { container } = render(<MarkdownDiff old={v1} new={v2} flavor="github" context={NEW} oldContext={OLD} onTooLarge={onTooLarge} />);
      await waitFor(() => expect(onTooLarge).toHaveBeenCalled());
      expect(container.textContent).toBe('');
    });

    it('a streamed one calls onTooLarge once its stream gives up, and shows no plain text', async () => {
      const big = Array.from({ length: 30 }, (_, i) => `## Part ${i}\n\n${'word '.repeat(400)}`).join('\n\n');
      slowClock();
      const onTooLarge = vi.fn();
      const { container } = render(<MarkdownDiff old={big} new={big.replace('Part 3', 'Part three')} flavor="github" context={NEW} oldContext={OLD} onTooLarge={onTooLarge} />);
      await waitFor(() => expect(onTooLarge).toHaveBeenCalled(), { timeout: 5000 });
      expect(container.textContent).toBe('');
    });

    it('without onTooLarge, the text shows as written with "Too large to render"', () => {
      slowClock();
      render(<MarkdownDiff old={v1} new={v2} flavor="github" context={NEW} oldContext={OLD} />);
      expect(screen.getByText('Too large to render')).toBeInTheDocument();
    });
  });

  it('is lazy-loadable from ../lazy', async () => {
    const { MarkdownDiff: Lazy } = await import('../lazy');
    render(<Suspense fallback="…"><Lazy old="" new={'Hi.\n'} flavor="github" context={NEW} oldContext={OLD} /></Suspense>);
    expect(await screen.findByRole('group', { name: 'Added' })).toHaveTextContent('Hi.');
  });
});
