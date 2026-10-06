import { render, screen, within } from '@testing-library/react';
import type { Element } from 'hast';
import type { Code, List, Paragraph, Root, RootContent, Table } from 'mdast';
import { describe, expect, it, vi } from 'vitest';
import type { FileMarkdownContext, MdCodeProps, MdImageProps, MdLinkProps } from './types';

// The element overrides are tested on their own: here, which side's context each one gets.
vi.mock('./MdLink', () => ({ MdLink: ({ ctx, href, children }: MdLinkProps) => <a data-commit={(ctx as { commit: string }).commit} data-href={href}>{children}</a> }));
vi.mock('./MdImage', () => ({ MdImage: ({ ctx, src }: MdImageProps) => <img data-commit={(ctx as { commit: string }).commit} data-src={src} alt="" /> }));
vi.mock('./MdCode', () => ({ MdCode: ({ code, marks, words }: MdCodeProps) => <pre data-testid="code" data-marks={marks ?? 'none'} data-words={words ?? 'none'}>{code}</pre> }));
vi.mock('./MdMermaid', () => ({ MdMermaid: ({ source }: { source: string }) => <pre data-testid="mermaid">{source}</pre> }));
const { renderTree, toSafeHast } = await import('./render');
const { clearParseCache, parseMarkdown } = await import('./parse');

const NEW: FileMarkdownContext = { kind: 'file', tabId: 't', commit: 'b'.repeat(40), path: 'docs/guide.md' };
const OLD: FileMarkdownContext = { kind: 'file', tabId: 't', commit: 'a'.repeat(40), path: 'docs/old-guide.md' };
const blocks = (md: string) => { clearParseCache(); return parseMarkdown(md, 'github').children; };
const root = (...children: RootContent[]): Root => ({ type: 'root', children });
const show = (tree: Root, diff = true) => render(<div>{renderTree(tree, NEW, diff ? { old: OLD } : undefined)}</div>).container;

describe('rendering a diff tree (5C)', () => {
  it('a marked block is a labelled wrapper; a removed one resolves its links and images on the old side', () => {
    const [para] = blocks('See the [guide](other.md) and ![logo](logo.png).') as [Paragraph];
    show(root({ type: 'diffBlock', mark: 'removed', children: [para] }, { type: 'diffBlock', mark: 'added', children: [para] }, { type: 'diffBlock', mark: 'changed', children: [para] }));
    const removed = screen.getByRole('group', { name: 'Removed' });
    const added = screen.getByRole('group', { name: 'Added' });
    expect(removed).toHaveClass('md-diff-block', 'md-diff-removed');
    expect(removed).toHaveAttribute('data-diff-mark', 'removed');
    expect(screen.getByRole('group', { name: 'Changed' })).toHaveClass('md-diff-changed');
    expect(removed.querySelector('a')).toHaveAttribute('data-commit', OLD.commit);
    expect(removed.querySelector('img')).toHaveAttribute('data-commit', OLD.commit);
    expect(added.querySelector('a')).toHaveAttribute('data-commit', NEW.commit);
    expect(added.querySelector('img')).toHaveAttribute('data-commit', NEW.commit);
  });

  it('removed words are <del>, added ones <ins>; a link in removed words resolves on the old side', () => {
    const para: Paragraph = { type: 'paragraph', children: [
      { type: 'text', value: 'Run ' },
      { type: 'diffDel', children: [{ type: 'link', url: 'old.md', children: [{ type: 'text', value: 'once' }] }] },
      { type: 'diffIns', children: [{ type: 'text', value: 'twice' }] },
      { type: 'text', value: '.' },
    ] };
    const c = show(root(para));
    expect(c.querySelector('del.md-diff-del')).toHaveTextContent('once');
    expect(c.querySelector('del a')).toHaveAttribute('data-commit', OLD.commit);
    expect(c.querySelector('ins.md-diff-ins')).toHaveTextContent('twice');
    expect(c.querySelector('p')).toHaveTextContent('Run oncetwice.');
  });

  it('an inline HTML element in changed words renders whole inside its <del> or <ins> (R13)', async () => {
    const { diffMarkdown } = await import('./diff/diffTree');
    clearParseCache();
    const c = show(diffMarkdown('Press <kbd>Ctrl</kbd> then <kbd>A</kbd> in the old menu.\n', 'Press <kbd>Ctrl</kbd> then <kbd>B</kbd> in the new menu.\n', 'github').root);
    expect(c.querySelector('del.md-diff-del kbd')).toHaveTextContent('A');
    expect(c.querySelector('ins.md-diff-ins kbd')).toHaveTextContent('B');
    expect(c.querySelectorAll('p > kbd')).toHaveLength(1);
    expect(c.querySelector('p')).toHaveTextContent('Press Ctrl then AB in the oldnew menu.');
  });

  it('marks list items and table rows; an ordered item keeps its number; a removed one resolves on the old side', () => {
    const [list] = blocks('1. one [a](a.md)\n2. two [b](b.md)\n') as [List];
    const [table] = blocks('| x |\n|---|\n| [c](c.md) |\n') as [Table];
    const marked: List = { ...list, children: [{ ...list.children[0]!, data: { gbValue: 1 } }, { ...list.children[1]!, data: { gbDiff: 'removed', gbValue: 2 } }] };
    const rows: Table = { ...table, children: [table.children[0]!, { ...table.children[1]!, data: { gbDiff: 'added' } }] };
    const c = show(root(marked, rows));
    const items = c.querySelectorAll('li');
    expect(items[0]).toHaveAttribute('value', '1');
    expect(items[0]).not.toHaveAttribute('data-diff-mark');
    expect(items[0]!.querySelector('a')).toHaveAttribute('data-commit', NEW.commit);
    expect(items[1]).toHaveAttribute('data-diff-mark', 'removed');
    expect(items[1]).toHaveClass('md-diff-removed');
    expect(items[1]).toHaveAttribute('value', '2');
    expect(items[1]!.querySelector('a')).toHaveAttribute('data-commit', OLD.commit);
    const tr = c.querySelector('tbody tr')!;
    expect(tr).toHaveAttribute('data-diff-mark', 'added');
    expect(tr).toHaveClass('md-diff-added');
  });

  it('hands a changed code block its line marks, and shows a changed diagram as a pair', () => {
    const code: Code = { type: 'code', lang: 'ts', value: 'a = 1\na = 2', data: { gbLines: '-+', gbWords: '4-5;4-5' } };
    const was: Code = { type: 'code', lang: 'mermaid', value: 'graph TD\n  A-->B' };
    const now: Code = { ...was, value: 'graph TD\n  A-->C' };
    const c = show(root({ type: 'diffBlock', mark: 'changed', children: [code] }, { type: 'diffPair', children: [{ type: 'diffBlock', mark: 'removed', children: [was] }, { type: 'diffBlock', mark: 'added', children: [now] }] }));
    expect(screen.getByTestId('code')).toHaveAttribute('data-marks', '-+');
    expect(screen.getByTestId('code')).toHaveAttribute('data-words', '4-5;4-5');
    const pair = c.querySelector<HTMLElement>('.md-diff-pair')!;
    expect(pair).toHaveAttribute('data-diff-mark', 'pair');
    expect(within(pair).getByRole('group', { name: 'Removed' })).toHaveTextContent('A-->B');
    expect(within(pair).getByRole('group', { name: 'Added' })).toHaveTextContent('A-->C');
  });

  it("ignores the document's own data-gb-diff, data-gb-lines, <ins> and <del>, and every mark outside a diff", () => {
    const c = show(root(...blocks('<div data-gb-diff="0000000000000000:added">x</div>\n\n<ul><li data-gb-diff="0:removed">y</li></ul>\n\nA <span data-gb-diff="0:ins">z</span> <del>w</del>.\n\n<pre><code data-gb-lines="0:-" data-gb-words="0:0-1">v</code></pre>\n')));
    expect(c.querySelector('[data-diff-mark], [data-gb-diff], [data-gb-lines], [data-gb-words], .md-diff-block, .md-diff-ins, .md-diff-del')).toBeNull();
    expect(c).toHaveTextContent('x');
    expect(screen.getByTestId('code')).toHaveAttribute('data-marks', 'none');
    expect(screen.getByTestId('code')).toHaveAttribute('data-words', 'none');
    const plain = show(root({ type: 'diffBlock', mark: 'added', children: blocks('Hi.') as Paragraph[] }), false);
    expect(plain.querySelector('[data-diff-mark], [data-gb-diff], [role="group"]')).toBeNull();
    expect(plain).toHaveTextContent('Hi.');
  });

  it('a document inside a real diff still cannot forge a mark, a class, a label or line marks (R17)', () => {
    const hostile = blocks([
      '<div data-diff-mark="added" class="md-diff-block md-diff-added" role="group" aria-label="Added">p</div>',
      '<ul><li data-diff-mark="removed" class="md-diff-removed" data-gb-diff="ffffffffffffffff:removed">q</li></ul>',
      '<table><tr data-gb-diff="ffffffffffffffff:added" class="md-diff-added"><td>r</td></tr></table>',
      'A <span class="md-diff-ins" data-gb-diff="ffffffffffffffff:ins">s</span> <ins class="md-diff-ins">t</ins> <del class="md-diff-del">u</del>.',
      '<pre><code class="language-ts" data-gb-lines="ffffffffffffffff:+-">v</code></pre>',
    ].join('\n\n') + '\n');
    const c = show(root({ type: 'diffBlock', mark: 'changed', children: hostile as Paragraph[] }));
    const real = screen.getByRole('group', { name: 'Changed' });
    expect(c.querySelectorAll('[data-diff-mark]')).toHaveLength(1);
    expect(c.querySelectorAll('[role="group"]')).toHaveLength(1);
    expect(real.querySelector('[data-diff-mark], [data-gb-diff], [data-gb-lines], [class*="md-diff"], [aria-label]')).toBeNull();
    expect(real.querySelector('ins')).not.toHaveClass('md-diff-ins');
    expect(real.querySelector('del')).not.toHaveClass('md-diff-del');
    expect(screen.getByTestId('code')).toHaveAttribute('data-marks', 'none');
    expect(real).toHaveTextContent(/p.*q.*r.*s.*t.*u.*v/s);
  });

  it("carries a mark through the sanitizer with this render's nonce", () => {
    const { hast, nonce } = toSafeHast(root({ type: 'diffBlock', mark: 'added', children: blocks('Hi.') as Paragraph[] }));
    const div = hast.children.find((n): n is Element => n.type === 'element' && n.tagName === 'div')!;
    expect(div.properties.dataGbDiff).toBe(`${nonce}:added`);
  });
});
