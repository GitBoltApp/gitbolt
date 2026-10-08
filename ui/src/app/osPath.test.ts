import { describe, expect, it, vi } from 'vitest';
import { basename, dirname, examplePath, joinPath, osKind } from './osPath';

describe('osPath', () => {
  it('basename', () => {
    expect(basename('/home/dev/app/')).toBe('app');
    expect(basename('/home/dev/a\\b')).toBe('a\\b');
    expect(basename('C:\\Users\\dev\\app')).toBe('app');
    expect(basename('C:/Users/dev/app')).toBe('app');
    expect(basename('\\\\srv\\share\\app\\')).toBe('app');
  });
  it('dirname', () => {
    expect(dirname('/r/shop')).toBe('/r');
    expect(dirname('/shop')).toBe('');
    expect(dirname('/r/a\\b')).toBe('/r');
    expect(dirname('C:\\r\\shop')).toBe('C:\\r');
    expect(dirname('C:\\r\\shop\\')).toBe('C:\\r');
    expect(dirname('\\\\srv\\share\\shop')).toBe('\\\\srv\\share');
  });
  it('joinPath uses the separator the base already uses', () => {
    expect(joinPath('/home/me/repos/', 'app')).toBe('/home/me/repos/app');
    expect(joinPath('/home/me', 'a/b')).toBe('/home/me/a/b');
    expect(joinPath('C:\\Users\\me\\repos\\', 'app')).toBe('C:\\Users\\me\\repos\\app');
    expect(joinPath('C:\\Users\\me', 'src/a.ts')).toBe('C:\\Users\\me\\src\\a.ts');
    expect(joinPath('C:/Users/me', 'app')).toBe('C:/Users/me/app');
  });
  it('examplePath follows the platform', () => {
    expect(examplePath('repos', 'linux')).toBe('/home/you/repos');
    expect(examplePath('repos/project', 'windows')).toBe('C:\\Users\\you\\repos\\project');
    expect(examplePath('.gitconfig-work', 'windows')).toBe('C:\\Users\\you\\.gitconfig-work');
    expect(examplePath('repos/project', 'macos')).toBe('/Users/you/repos/project');
  });
  it('osKind reads the user agent', () => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get');
    ua.mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
    expect(osKind()).toBe('macos');
    ua.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
    expect(osKind()).toBe('windows');
    ua.mockReturnValue('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
    expect(osKind()).toBe('linux');
    ua.mockRestore();
  });
});
