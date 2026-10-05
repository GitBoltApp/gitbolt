import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./render', () => ({ renderTree: () => { throw new Error('boom'); } }));
const { Markdown } = await import('./Markdown');

describe('a body that fails to render (spec #5 §6)', () => {
  it('shows as plain text with a small note, and the others are unaffected', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<><Markdown flavor="github" context={{ kind: 'forge', tabId: 't' }} text="**bold** body" /><p>sibling</p></>);
    expect(screen.getByText("Couldn't render")).toBeInTheDocument();
    expect(document.querySelector('.md-plain')).toHaveTextContent('**bold** body');
    expect(screen.getByText('sibling')).toBeInTheDocument();
  });
});
