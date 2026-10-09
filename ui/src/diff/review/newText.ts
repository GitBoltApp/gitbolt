import { createContext } from 'react';

/** The new side's 1-based lines `from`..`to` of the file a review's cards are in (fewer, or null,
 * past either end). */
export type NewLines = (from: number, to: number) => readonly string[] | null;

/**
 * The diff's new-side text, for the cards and boxes under its lines: what a suggestion in them
 * replaces (`MdSuggestionBase`). The source diff's editor or the rendered diff's file provides it.
 */
export const ReviewNewText = createContext<NewLines | null>(null);

/** `NewLines` over a whole text. */
export function textLines(text: string): NewLines {
  const lines = text.split(/\r?\n/);
  return (from, to) => (from < 1 ? null : lines.slice(from - 1, to));
}
