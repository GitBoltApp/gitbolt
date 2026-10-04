import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MR_DRAFT_STORAGE_KEY, discardMrDraft, flushMrDrafts, mrDraftKey, readMrDraft, reloadMrDrafts, writeMrDraft, type MrDraft } from './draft';

const grace = { id: 8, username: 'grace', name: 'Grace Hopper', avatarUrl: null, webUrl: 'https://g/grace', email: null };
const d: MrDraft = {
  sourceRemote: 'origin', targetRemote: 'origin', targetBranch: 'main', title: 'Add login', description: 'Why.', prefilled: 'Why.', template: null,
  reviewers: [grace], assignees: [], labels: ['bug'], draft: false, squash: true, deleteSourceBranch: false,
};
const stored = () => JSON.parse(localStorage.getItem(MR_DRAFT_STORAGE_KEY) ?? '{}') as Record<string, MrDraft>;

beforeEach(() => {
  flushMrDrafts();
  localStorage.clear();
  reloadMrDrafts();
});
afterEach(() => vi.useRealTimers());

describe('Create MR/PR drafts (spec #4 §2: resumable per repo + source branch)', () => {
  it('keeps one draft per repo and branch across a restart', () => {
    writeMrDraft('/r/shop', 'feature', d);
    writeMrDraft('/r/shop', 'other', { ...d, title: 'Other' });
    flushMrDrafts();
    reloadMrDrafts();
    expect(readMrDraft('/r/shop', 'feature')).toEqual(d);
    expect(readMrDraft('/r/shop', 'other')?.title).toBe('Other');
    expect(readMrDraft('/r/elsewhere', 'feature')).toBeNull();
  });

  it('writes after a short pause, and at once on pagehide', () => {
    vi.useFakeTimers();
    writeMrDraft('/r/shop', 'feature', d);
    expect(localStorage.getItem(MR_DRAFT_STORAGE_KEY)).toBeNull();
    vi.advanceTimersByTime(300);
    expect(stored()[mrDraftKey('/r/shop', 'feature')].title).toBe('Add login');
    writeMrDraft('/r/shop', 'feature', { ...d, title: 'Edited' });
    window.dispatchEvent(new Event('pagehide'));
    expect(stored()[mrDraftKey('/r/shop', 'feature')].title).toBe('Edited');
  });

  it('discarding removes it from storage at once', () => {
    writeMrDraft('/r/shop', 'feature', d);
    flushMrDrafts();
    discardMrDraft('/r/shop', 'feature');
    expect(readMrDraft('/r/shop', 'feature')).toBeNull();
    expect(stored()).toEqual({});
  });

  it('drops malformed entries one by one and survives unreadable or full storage', () => {
    localStorage.setItem(MR_DRAFT_STORAGE_KEY, JSON.stringify({
      [mrDraftKey('/r', 'a')]: d,
      [mrDraftKey('/r', 'b')]: { ...d, title: 3 },
      [mrDraftKey('/r', 'c')]: { ...d, reviewers: [{ id: 'x' }] },
      [mrDraftKey('/r', 'd')]: { ...d, squash: 'yes' },
    }));
    reloadMrDrafts();
    expect(readMrDraft('/r', 'a')).toEqual(d);
    expect([readMrDraft('/r', 'b'), readMrDraft('/r', 'c'), readMrDraft('/r', 'd')]).toEqual([null, null, null]);
    localStorage.setItem(MR_DRAFT_STORAGE_KEY, '{not json');
    reloadMrDrafts();
    expect(readMrDraft('/r', 'a')).toBeNull();
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    writeMrDraft('/r', 'z', d);
    expect(() => flushMrDrafts()).not.toThrow();
    expect(readMrDraft('/r', 'z')).toEqual(d);
    full.mockRestore();
  });

  it('never persists email addresses', () => {
    writeMrDraft('/r', 'f', { ...d, reviewers: [{ ...grace, email: 'g@example.com' }] });
    flushMrDrafts();
    expect(localStorage.getItem(MR_DRAFT_STORAGE_KEY)).not.toContain('g@example.com');
  });
});
