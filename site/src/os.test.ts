import { expect, test } from 'vitest';
import { detectOs } from './os.ts';

test.each([
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', 'Linux x86_64', 0, 'linux'],
  ['Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Linux x86_64', 0, 'linux'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', 'Win32', 0, 'windows'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15', 'MacIntel', 0, 'macos'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15', 'MacIntel', 5, null],
  ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36', 'Linux armv81', 5, null],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1', 'iPhone', 5, null],
  ['Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', 'Linux x86_64', 0, null],
  ['', '', 0, null],
] as const)('%s on %s (%i touch points): %s', (userAgent, platform, maxTouchPoints, os) => {
  expect(detectOs({ userAgent, platform, maxTouchPoints })).toBe(os);
});

test('client hints win where the browser has them; "Darwin" is not Windows', () => {
  expect(detectOs({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', userAgentData: { platform: 'macOS' } })).toBe('macos');
  expect(detectOs({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', userAgentData: { platform: 'Windows' } })).toBe('windows');
  expect(detectOs({ userAgent: 'curl/8 (Darwin)' })).toBeNull();
});
