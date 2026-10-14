/**
 * GitBolt, the app's name before 0.7.0, kept the UI's preferences and drafts under `gitbolt.*`
 * localStorage keys; GitVolt's are `gitvolt.*`. Chromium's profile, which holds them, moved with
 * the app's folders (core's `migrate.rs`). Once, before anything reads them, each old key's value
 * takes the new name, unless the new one is set already; the old key goes either way.
 */
export const LEGACY_PREFIX = 'gitbolt.';
export const PREFIX = 'gitvolt.';

/** Moves `storage`'s old keys to the new names; the number of values moved. */
export function adoptLegacyKeys(storage: Storage): number {
  const old: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(LEGACY_PREFIX)) old.push(key);
  }
  let moved = 0;
  for (const key of old) {
    const value = storage.getItem(key);
    const next = PREFIX + key.slice(LEGACY_PREFIX.length);
    if (value !== null && storage.getItem(next) === null) {
      storage.setItem(next, value);
      moved++;
    }
    storage.removeItem(key);
  }
  return moved;
}
