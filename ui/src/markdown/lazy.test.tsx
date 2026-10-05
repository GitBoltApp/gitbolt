import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { lazyMarkdown, Markdown, preloadMarkdown } from './lazy';

const props = { flavor: 'github', context: { kind: 'forge', tabId: 't' }, text: '## Soon\n\nBody' } as const;

describe('the lazy <Markdown>', () => {
  // The chunk's first import (remark, rehype, Shiki) is the slow part under load: a hook with its
  // own budget, not the test's.
  beforeAll(() => preloadMarkdown(), 60_000);

  it('shows the plain text while its chunk loads', () => {
    const { Markdown: Pending } = lazyMarkdown(() => new Promise(() => {}));
    const { container } = render(<Pending {...props} className="x" />);
    expect(container.querySelector('.md-plain')).toHaveTextContent('## Soon');
    expect(container.firstElementChild).toHaveClass('md', 'x');
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('warms the chunk once the app is idle, once, and a cancel before then loads nothing', async () => {
    const load = vi.fn(async () => ({ Markdown: () => <p>body</p> }));
    const lazy = lazyMarkdown(load);
    lazy.preloadWhenIdle()(); // a tab that unmounted at once
    await new Promise((r) => setTimeout(r, 10));
    expect(load).not.toHaveBeenCalled();
    lazy.preloadWhenIdle();
    lazy.preloadWhenIdle(); // a second tab
    expect(load).not.toHaveBeenCalled(); // not during startup's own work
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const { container } = render(<lazy.Markdown {...props} />);
    expect(container).toHaveTextContent('body');
    lazy.preloadWhenIdle();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('renders the body from its chunk, at once once preloaded', () => {
    render(<Markdown {...props} />);
    expect(screen.getByRole('heading', { name: 'Soon' })).toBeInTheDocument();
  });
});
