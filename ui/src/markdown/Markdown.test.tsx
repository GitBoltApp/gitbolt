import { render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEmoji } from '../forge/emoji';
import { Markdown } from './Markdown';
import { clearParseCache } from './parse';

const ctx = { kind: 'forge', tabId: 't' } as const;
beforeAll(async () => { await loadEmoji(); });
beforeEach(() => clearParseCache());

describe('<Markdown> (spec #5 §3.1)', () => {
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
