import { createElement, Fragment, useEffect, useSyncExternalStore, type ReactElement } from 'react';

/**
 * GitHub's and GitLab's emoji shortcodes (`feature :gear:`) as Unicode emoji, in label names, MR/PR
 * titles and system notes. The name → emoji map is gemoji's (GitHub's own list, which GitLab's
 * names follow), loaded on first need as its own chunk. An unknown shortcode stays as text, and
 * the result is only ever React text.
 */
const SHORTCODE = /:([a-z0-9_+-]+):/gi;
const HAS_SHORTCODE = /:[a-z0-9_+-]+:/i;

let names: Readonly<Record<string, string>> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/** Loads the map once (a failed load is tried again on the next need). */
export function loadEmoji(): Promise<void> {
  loading ??= import('gemoji').then(
    (m) => {
      names = m.nameToEmoji;
      for (const l of listeners) l();
    },
    () => { loading = null; },
  );
  return loading;
}

/** A lone text-presentation emoji (⚙ U+2699) gets U+FE0F, or it draws monochrome. */
const colourful = (e: string): string => (/^\p{Emoji}$/u.test(e) && !/^\p{Emoji_Presentation}$/u.test(e) && !/^[#*0-9]$/.test(e) ? `${e}️` : e);

const lookup = (map: Readonly<Record<string, string>>, name: string): string | undefined =>
  Object.hasOwn(map, name) ? colourful(map[name]) : Object.hasOwn(map, name.toLowerCase()) ? colourful(map[name.toLowerCase()]) : undefined;

/** `text` with each known `:shortcode:` replaced by its emoji; as is without a map. */
export function emojify(text: string, map: Readonly<Record<string, string>> | null = names): string {
  if (!map || !text.includes(':')) return text;
  return text.replace(SHORTCODE, (whole, name: string) => lookup(map, name) ?? whole);
}

/** `emojify(text)`, re-rendered once the map arrives (asked for only when `text` has a shortcode). */
export function useEmoji(text: string): string {
  const map = useSyncExternalStore(subscribe, () => names);
  const wants = map === null && HAS_SHORTCODE.test(text);
  useEffect(() => {
    if (wants) void loadEmoji();
  }, [wants]);
  return emojify(text, map);
}

/** `useEmoji` as an element, for lists. */
export function EmojiText({ text }: { text: string }): ReactElement {
  return createElement(Fragment, null, useEmoji(text));
}
