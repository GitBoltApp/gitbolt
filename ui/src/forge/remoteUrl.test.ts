import { describe, expect, it } from 'vitest';
import type { ForgeProject } from '../api/gen/ForgeProject';
import { forkCloneUrl, freeRemoteName, parseRemoteUrl, remoteNameError, remoteUrlError } from './remoteUrl';

const fork: ForgeProject = {
  kind: 'gitlab', id: 77, host: 'gitlab.example.com', path: 'alice/project', name: 'project', owner: 'alice', webUrl: 'https://gitlab.example.com/alice/project',
  defaultBranch: 'main', cloneHttps: 'https://gitlab.example.com/alice/project.git', cloneSsh: 'git@gitlab.example.com:alice/project.git', forkOf: 'group/project', updatedAt: 1, archived: false,
};

describe('remote URLs (the Rust parse_remote_url, same table)', () => {
  it('parses https, ssh and scp shapes, and refuses local paths', () => {
    expect(parseRemoteUrl('https://gitlab.example.com/Acme/shop.git')).toEqual({ host: 'gitlab.example.com', path: 'Acme/shop' });
    expect(parseRemoteUrl('git@github.com:owner/repo.git')).toEqual({ host: 'github.com', path: 'owner/repo' });
    expect(parseRemoteUrl('ssh://git@gitlab.com:2222/a/b/c.git')).toEqual({ host: 'gitlab.com', path: 'a/b/c' });
    expect(parseRemoteUrl('https://user:tok@GitHub.com/o/r/')).toEqual({ host: 'github.com', path: 'o/r' });
    expect(parseRemoteUrl('/tmp/origin.git')).toBeNull();
    expect(parseRemoteUrl('file:///tmp/origin.git')).toBeNull();
    expect(parseRemoteUrl('')).toBeNull();
  });

  it('checks names as git does, said of a remote, and refuses option-like or broken URLs', () => {
    expect(remoteNameError('', [])).toBe('Enter a remote name');
    expect(remoteNameError('a..b', [])).toBe("A remote name can't contain ..");
    expect(remoteNameError('origin', ['origin'])).toBe('A remote named origin already exists');
    expect(remoteNameError('alice', ['origin'])).toBeNull();
    expect(remoteNameError('-x', [])).not.toBeNull();
    expect(remoteNameError('a b', [])).not.toBeNull();
    expect(remoteUrlError('')).toBe("Enter the remote's URL");
    expect(remoteUrlError('--upload-pack=x')).toBe("A remote URL can't start with -");
    expect(remoteUrlError('https://h/a b.git')).toBe("A remote URL can't contain spaces or control characters");
    expect(remoteUrlError('https://h/a.git')).toBeNull();
  });

  it('names a fork after its owner, taking the next free number', () => {
    expect(freeRemoteName('alice', ['origin'])).toBe('alice');
    expect(freeRemoteName('Alice', ['origin', 'alice'])).toBe('alice-2');
    expect(freeRemoteName('alice', ['alice', 'alice-2'])).toBe('alice-3');
    expect(freeRemoteName('team sub', [])).toBe('team-sub');
    expect(freeRemoteName('', [])).toBe('remote');
  });

  it("adds a fork over SSH when origin is SSH, else HTTPS", () => {
    expect(forkCloneUrl('git@gitlab.example.com:group/project.git', fork)).toBe('git@gitlab.example.com:alice/project.git');
    expect(forkCloneUrl('ssh://git@gitlab.example.com/group/project.git', fork)).toBe('git@gitlab.example.com:alice/project.git');
    expect(forkCloneUrl('https://***@gitlab.example.com/group/project.git', fork)).toBe('https://gitlab.example.com/alice/project.git');
    expect(forkCloneUrl('/srv/git/project.git', fork)).toBe('https://gitlab.example.com/alice/project.git');
    expect(forkCloneUrl('git://gitlab.example.com/group/project.git', fork)).toBe('https://gitlab.example.com/alice/project.git');
    expect(forkCloneUrl(null, fork)).toBe('https://gitlab.example.com/alice/project.git');
  });
});
