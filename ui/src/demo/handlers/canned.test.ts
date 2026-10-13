import { describe, expect, it } from 'vitest';
import { cannedHandlers } from './canned';
import { fakeCtx, makeTestRepo } from '../engine/read/testkit';

describe('canned handlers', () => {
  it('lists the demo\'s repositories under /demo, and nothing elsewhere', async () => {
    const orbital = await makeTestRepo('orbital');
    await orbital.write('a.txt', 'a\n');
    await orbital.commit('Start');
    const basic = await makeTestRepo('basic');
    const ctx = fakeCtx(orbital.repo, basic.repo);
    expect(await cannedHandlers.suggestReposFolder(undefined as never, ctx)).toBe('/demo');
    const scanned = await cannedHandlers.scanRepos({ root: '/demo/', refresh: false }, ctx);
    expect(scanned.map((r) => [r.path, r.name, r.branch])).toEqual([['/demo/orbital', 'orbital', 'main'], ['/demo/basic', 'basic', 'main']]);
    expect(scanned[0].modified).toBeGreaterThan(scanned[1].modified);
    expect(await cannedHandlers.scanRepos({ root: '/home/someone', refresh: true }, ctx)).toEqual([]);
    expect(await cannedHandlers.scanFolders({ roots: ['/demo', '/demo', '/x'], refresh: false }, ctx)).toHaveLength(2);
  });

  it('answers the static ones plausibly', async () => {
    const ctx = fakeCtx();
    expect(await cannedHandlers.updateStatus(undefined as never, ctx)).toEqual({ state: 'upToDate' });
    expect(await cannedHandlers.updateCheck(undefined as never, ctx)).toEqual({ state: 'upToDate' });
    expect((await cannedHandlers.listOpeners(undefined as never, ctx)).map((o) => o.kind)).toEqual(['editor', 'fileManager']);
    const text = await cannedHandlers.diagnostics({ ui: { userAgent: 'Mozilla/5.0 Chrome/152.0.7977.83 Safari/537.36', settings: { theme: 'dark', forgeToken: 'glpat-FAKE-00000000000000000000' } } }, ctx);
    expect(text).toContain('Chromium: 152.0.7977.83');
    expect(text).toContain('"theme": "dark"');
    expect(text).not.toContain('glpat-');
  });

  it('checks an editor template the way the core does, without resolving the program', async () => {
    const ctx = fakeCtx();
    const check = (template: string) => cannedHandlers.validateEditorTemplate({ template }, ctx);
    await expect(check('code --goto {file}:{line}')).resolves.toBeNull();
    await expect(check('   ')).rejects.toMatchObject({ kind: 'InvalidInput', message: 'empty editor command' });
    await expect(check('code "unclosed')).rejects.toMatchObject({ kind: 'InvalidInput' });
    await expect(check('sh -c "vim {file}"')).rejects.toMatchObject({ kind: 'InvalidInput' });
    await expect(check('sh -c \'ed "$1"\' sh {file}')).resolves.toBeNull();
  });
});
