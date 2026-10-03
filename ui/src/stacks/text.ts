// ui/src/stacks/text.ts
/** `refs/heads/main` → `main`; `refs/remotes/origin/main` → `origin/main`. */
export const shortRef = (ref: string): string => ref.replace(/^refs\/(heads|remotes)\//, '');

/** `a`; `a and b`; `a, b and c`. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
