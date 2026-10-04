import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RemoteFetchWarning, fetchFailedTip } from './RemoteFetchWarning';

describe('RemoteFetchWarning', () => {
  it('words the tooltip with the reason and when', () => {
    expect(fetchFailedTip("couldn't reach git.example.com", 0, 3 * 3600_000)).toBe("Last fetch failed: couldn't reach git.example.com (3 hours ago)");
  });
  it('renders a labelled triangle', () => {
    render(<RemoteFetchWarning remote="gone" reason="authentication failed" at={Date.now()} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Last fetch failed: authentication failed (just now)');
  });
});
