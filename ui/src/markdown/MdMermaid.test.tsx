import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));
const { MdMermaid } = await import('./MdMermaid');

beforeEach(() => vi.clearAllMocks());

describe('MdMermaid (spec #5 §3.1)', () => {
  it('draws the diagram lazily in strict mode, as an image of the sanitized SVG', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><g onclick="x"><text>Start</text></g></svg>' });
    const { container } = render(<MdMermaid source={'graph TD; A-->B'} />);
    expect(container).toHaveTextContent('graph TD; A-->B');
    const img = await screen.findByRole('img', { name: 'Mermaid diagram' });
    const svg = decodeURIComponent(img.getAttribute('src')!.replace('data:image/svg+xml;charset=utf-8,', ''));
    expect(svg).toContain('<text>Start</text>');
    expect(svg).not.toMatch(/script|onclick/);
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false }));
  });

  it('shows the source with the error under it when the diagram can’t be drawn', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error on line 1'));
    render(<MdMermaid source="graph ???" />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent("Couldn't draw the diagram: Parse error on line 1"));
    expect(screen.getByText('graph ???')).toBeInTheDocument();
  });
});
