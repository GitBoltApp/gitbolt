import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MrCard } from './MrCard';
import { detailOf, mrOf, user } from './testMrs';

describe('MrCard (spec #4 §4 "4B": the hover card)', () => {
  const mr = mrOf(12, { title: 'Dev work', pipeline: { status: 'success', webUrl: null }, conflicts: null });

  it('shows at once what the badge knows, and Loading… for what the detail adds', () => {
    render(<MrCard kind="gitlab" mr={mr} detail={null} hint="Click to open" />);
    const card = screen.getByLabelText('Merge request !12 details');
    expect(card).toHaveTextContent('!12 Dev work');
    expect(card).toHaveTextContent('Grace Hopper · dev → main');
    expect(card).toHaveTextContent('Pipeline passed');
    expect(card).toHaveTextContent('Loading…');
    expect(card).toHaveTextContent('Click to open');
  });

  it("shows the detail's review and conflicts, and a draft", () => {
    const draft = mrOf(5, { state: 'draft', title: 'Explore' });
    const d = detailOf(draft, { mr: { ...draft, conflicts: true, review: { decision: 'approved', approvals: 1, approvalsRequired: null, reviews: [{ user: user('Ada Lovelace'), state: 'approved', submittedAt: null }] } } });
    render(<MrCard kind="github" mr={draft} detail={d} />);
    const card = screen.getByLabelText('Pull request #5 details');
    expect(card).toHaveTextContent('· Draft');
    expect(card).toHaveTextContent('No checks');
    expect(card).toHaveTextContent('Approved by Ada Lovelace');
    expect(card).toHaveTextContent('Has conflicts');
    expect(card).not.toHaveTextContent('Loading…');
  });

  it("says why the detail couldn't load", () => {
    render(<MrCard kind="gitlab" mr={mr} detail={null} error="gitlab.example.com rate limit reached: try again in 2 min" />);
    expect(screen.getByLabelText('Merge request !12 details')).toHaveTextContent("Couldn't load: gitlab.example.com rate limit reached: try again in 2 min");
  });
});
