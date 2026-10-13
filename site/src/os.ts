// The visitor's desktop platform, for the downloads (spec §6.1 items 1 and 6). Phones, tablets
// and Chromebooks get none: there's nothing to install there.
export type Os = 'linux' | 'macos' | 'windows';
export interface NavigatorLike {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string };
}

export function detectOs(nav: NavigatorLike): Os | null {
  const all = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent}`;
  if (/Android|iPhone|iPad|iPod|CrOS/.test(all)) return null;
  if (/\bWindows\b|\bWin(32|64)\b/.test(all)) return 'windows';
  // iPadOS says it's a Mac; a Mac has no touch screen.
  if (/\bMac|\bmacOS\b/.test(all)) return (nav.maxTouchPoints ?? 0) > 1 ? null : 'macos';
  if (/\bLinux\b|\bX11\b/.test(all)) return 'linux';
  return null;
}
