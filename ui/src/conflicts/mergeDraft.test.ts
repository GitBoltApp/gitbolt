import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readWipDraft, writeWipDraft } from '../commit/draft';
import { applyMergeDraft, mergeDraft, restoreDraftAfterAbort, settleDraftAside } from './mergeDraft';

const confirm = vi.hoisted(() => vi.fn());
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: confirm }));

const MSG = "Merge branch 'feature/x'\n\n# Conflicts:\n#\ta.txt\n";

describe('the WIP draft when a merge stops (spec #2 §8.2)', () => {
  it('keeps the summary and puts MERGE_MSG below the description', () => {
    expect(mergeDraft({ summary: 'Fix login', description: 'Because.' }, MSG)).toEqual({ summary: 'Fix login', description: "Because.\n\nMerge branch 'feature/x'" });
  });
  it('an empty summary takes the first line, the description the rest', () => {
    expect(mergeDraft({ summary: '', description: '' }, "Merge branch 'feature/x'\n\nDetails\n# Conflicts:\n")).toEqual({ summary: "Merge branch 'feature/x'", description: 'Details' });
  });
  it('normalises line endings', () => {
    expect(mergeDraft({ summary: '', description: '' }, 'Merge x\r\n\r\nbody\r\n').description).toBe('body');
  });
});

describe('the draft set aside', () => {
  const head = 'a'.repeat(40);
  beforeEach(() => {
    localStorage.clear();
    confirm.mockReset();
    writeWipDraft('/r', '/r', { summary: 'Mine', description: '' });
  });
  it('applies once per merge and never drops what was typed', () => {
    applyMergeDraft('/r', '/r', MSG, head);
    expect(readWipDraft('/r', '/r')).toEqual({ summary: 'Mine', description: "Merge branch 'feature/x'" });
    writeWipDraft('/r', '/r', { summary: 'Mine, edited', description: "Merge branch 'feature/x'" });
    applyMergeDraft('/r', '/r', MSG, head);
    expect(readWipDraft('/r', '/r').summary).toBe('Mine, edited');
  });
  it('Abort restores an untouched merge message without asking', async () => {
    applyMergeDraft('/r', '/r', MSG, head);
    await restoreDraftAfterAbort('/r', '/r');
    expect(confirm).not.toHaveBeenCalled();
    expect(readWipDraft('/r', '/r')).toEqual({ summary: 'Mine', description: '' });
  });
  it('Abort asks before replacing an edited message, and keeps it on No', async () => {
    applyMergeDraft('/r', '/r', MSG, head);
    writeWipDraft('/r', '/r', { summary: 'Resolved login', description: '' });
    confirm.mockResolvedValue(false);
    await restoreDraftAfterAbort('/r', '/r');
    expect(confirm).toHaveBeenCalledOnce();
    expect(readWipDraft('/r', '/r').summary).toBe('Resolved login');
  });
  it('a merge that ended elsewhere keeps an edited message', () => {
    applyMergeDraft('/r', '/r', MSG, head);
    writeWipDraft('/r', '/r', { summary: 'Edited', description: '' });
    settleDraftAside('/r', '/r');
    expect(readWipDraft('/r', '/r').summary).toBe('Edited');
  });
});
