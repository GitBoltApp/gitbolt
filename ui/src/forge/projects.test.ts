import { describe, expect, it } from 'vitest';
import { mappedRemotes } from './projects';

const project = (path: string, host = 'gitlab.example.com') => ({
  kind: 'gitlab' as const, id: 1, host, path, name: 'project', owner: path.split('/')[0], webUrl: `https://${host}/${path}`, defaultBranch: 'main',
  cloneHttps: '', cloneSsh: '', forkOf: null, updatedAt: null, archived: false,
});
const RP = {
  remotes: [
    { remote: 'origin', host: 'gitlab.example.com', path: 'me/project', account: 'gitlab' as const, project: { ...project('me/project'), forkOf: 'group/project' }, error: null },
    { remote: 'upstream', host: 'gitlab.example.com', path: 'group/project', account: 'gitlab' as const, project: project('group/project'), error: null },
    { remote: 'gh', host: 'github.com', path: 'o/r', account: null, project: null, error: null },
  ],
  target: 'upstream',
};

describe('the remotes a flyout can push from or to', () => {
  it("are the ones with a project on the target's host", () => {
    expect(mappedRemotes(RP, 'gitlab.example.com')).toEqual(['origin', 'upstream']);
    expect(mappedRemotes(RP, 'github.com')).toEqual([]);
    expect(mappedRemotes(null, 'gitlab.example.com')).toEqual([]);
  });

  it('matches a ported project host to a port-less remote host, and skips remotes without a project', () => {
    const rp = { remotes: [
      { remote: 'a', host: 'gitlab.example.com', path: 'x/y', account: 'gitlab' as const, project: project('x/y', 'gitlab.example.com:8443'), error: null },
      { remote: 'b', host: 'gitlab.example.com', path: 'x/z', account: null, project: null, error: null },
    ], target: 'a' };
    expect(mappedRemotes(rp, 'gitlab.example.com:8443')).toEqual(['a']);
    expect(mappedRemotes(rp, 'gitlab.example.com')).toEqual(['a']);
  });
});
