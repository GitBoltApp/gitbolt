import { create } from 'zustand';

/** Half-written replies by tab, MR/PR and discussion, for the session: closing the view (Esc,
 * ×) keeps them, sending clears them (Review Focus 4). */
export const useReplyDrafts = create<{ text: Record<string, string> }>(() => ({ text: {} }));
export const draftKey = (tabId: string, number: number, discussion: string | null): string => `${tabId}:${number}:${discussion ?? 'new'}`;
export const setDraft = (key: string, text: string): void => useReplyDrafts.setState((s) => ({ text: { ...s.text, [key]: text } }));
export function clearDraft(key: string): void {
  useReplyDrafts.setState((s) => {
    const text = { ...s.text };
    delete text[key];
    return { text };
  });
}
