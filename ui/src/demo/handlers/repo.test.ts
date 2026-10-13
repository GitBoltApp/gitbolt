import { describe, expect, test } from 'vitest';
import type { StatePayload } from '../../api/gen/StatePayload';
import { createRuntime } from '../runtime';
import { goldenData, goldenManifest, noGraph } from '../testing';
import { createDemoTransport } from '../transport';
import { HANDLERS } from '.';

const transport = () => createDemoTransport(Promise.resolve(createRuntime({ manifest: goldenManifest(), data: goldenData(), graph: noGraph })), HANDLERS);

describe('repo handlers', () => {
  test('openRepo: one id per repository, from any path in a worktree', async () => {
    const t = transport();
    expect(await t.call({ method: 'openRepo', params: { path: '/demo/basic' } })).toEqual({ id: 1, path: '/demo/basic', name: 'basic', worktree: '/demo/basic' });
    expect(await t.call({ method: 'openRepo', params: { path: '/demo/.extra/basic/wt-hotfix' } })).toEqual({ id: 1, path: '/demo/basic', name: 'basic', worktree: '/demo/.extra/basic/wt-hotfix' });
    await expect(t.call({ method: 'openRepo', params: { path: '/home/someone' } })).rejects.toMatchObject({ kind: 'NotFound', message: 'Not a git repository: /home/someone' });
  });

  test('peekRepo: a worktree root only', async () => {
    const t = transport();
    expect(await t.call({ method: 'peekRepo', params: { path: '/demo/basic' } })).toEqual({ remotes: [{ name: 'origin', host: null, path: null, hostKind: 'generic' }], branch: 'main' });
    expect(await t.call({ method: 'peekRepo', params: { path: '/demo/.extra/basic/wt-hotfix' } })).toMatchObject({ branch: 'hotfix' });
    await expect(t.call({ method: 'peekRepo', params: { path: '/demo/basic/src' } })).rejects.toMatchObject({ kind: 'NotFound' });
  });

  test('repoInfo', async () => {
    const t = transport();
    await t.call({ method: 'openRepo', params: { path: '/demo/basic' } });
    expect(await t.call({ method: 'repoInfo', params: { repo: 1 } })).toEqual({ remotes: [{ name: 'origin', url: '/demo/.origins/basic.git', host: null, path: null, hostKind: 'generic' }], mainWorktree: null, commonDir: '/demo/basic/.git', submodules: {} });
    await expect(t.call({ method: 'repoInfo', params: { repo: 9 } })).rejects.toMatchObject({ kind: 'InvalidInput', message: 'no open repository with id 9' });
  });

  test('state round-trips in memory', async () => {
    const t = transport();
    const s = (await t.call({ method: 'loadState' })) as StatePayload;
    expect(s.profile.tabs.map((x) => x.path)).toEqual(goldenManifest().repos.map((r) => `/demo/${r.name}`));
    expect(s.profile.activeTab).toBe('demo-basic');
    s.settings.theme = 'mutated-copy';
    expect(((await t.call({ method: 'loadState' })) as StatePayload).settings.theme).toBe('default-dark');
    await t.call({ method: 'saveSettings', params: { settings: { ...s.settings, theme: 'light' } } });
    await t.call({ method: 'saveProfile', params: { profile: { ...s.profile, name: 'Mine' } } });
    const after = (await t.call({ method: 'loadState' })) as StatePayload;
    expect([after.settings.theme, after.profile.name, after.profiles[0].name]).toEqual(['light', 'Mine', 'Mine']);
  });

  test('watching, and the boot plumbing', async () => {
    const t = transport();
    await expect(t.call({ method: 'watchRepo', params: { repo: 1 } })).rejects.toMatchObject({ kind: 'InvalidInput' });
    await t.call({ method: 'openRepo', params: { path: '/demo/basic' } });
    expect(await t.call({ method: 'watchRepo', params: { repo: 1 } })).toBeNull();
    expect(await t.call({ method: 'unwatchRepo', params: { repo: 1 } })).toBeNull();
    expect(await t.call({ method: 'unwatchAll' })).toBeNull();
    expect(await t.call({ method: 'launchRepo' })).toBeNull();
    expect(await t.call({ method: 'takeOpenRequests' })).toEqual([]);
    expect(await t.call({ method: 'logFrontend', params: { level: 'info', message: 'x', stack: null } })).toBeNull();
    expect(await t.call({ method: 'setDebugLogging', params: { debug: true } })).toBeNull();
    expect(await t.call({ method: 'appInfo' })).toMatchObject({ build: null, installKind: 'none', home: null, gitVersion: 'in-browser (isomorphic-git)' });
  });
});
