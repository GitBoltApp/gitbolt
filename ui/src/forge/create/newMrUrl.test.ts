import { describe, expect, it } from 'vitest';
import type { ForgeProject } from '../../api/gen/ForgeProject';
import type { MrDraft } from './draft';
import { MAX_URL_LENGTH, newMrUrl } from './newMrUrl';

const gitlab: ForgeProject = {
  kind: 'gitlab', id: 42, host: 'gitlab.example.com', path: 'group/project', name: 'project', owner: 'group', webUrl: 'https://gitlab.example.com/group/project',
  defaultBranch: 'main', cloneHttps: '', cloneSsh: '', forkOf: null, updatedAt: null, archived: false, ownerAvatarUrl: null,
};
const github: ForgeProject = { ...gitlab, kind: 'github', id: 501, host: 'github.com', path: 'octo-org/widget', owner: 'octo-org', webUrl: 'https://github.com/octo-org/widget' };
const d: MrDraft = {
  sourceRemote: 'origin', targetRemote: 'origin', targetBranch: 'main', title: 'Add login', description: 'Why?\n\n- a', prefilled: '', template: null,
  reviewers: [], assignees: [{ id: 2, username: 'hubot', name: 'Hubot', avatarUrl: null, webUrl: '', email: null }], labels: ['bug', 'ui'], draft: true, squash: null, deleteSourceBranch: null,
};

describe('"Continue editing on…" (spec #4 §4 "4C", ruling 14)', () => {
  it("GitLab's new-MR page takes the branches, the title (draft as its prefix) and the description", () => {
    expect(newMrUrl(gitlab, { project: 'group/project', branch: 'feature/login' }, d)).toEqual({
      url: 'https://gitlab.example.com/group/project/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Flogin&merge_request%5Btarget_branch%5D=main&merge_request%5Btitle%5D=Draft%3A%20Add%20login&merge_request%5Bdescription%5D=Why%3F%0A%0A-%20a',
      withoutDescription: false,
    });
  });

  it("a fork's MR opens on the fork and names the target project", () => {
    const { url } = newMrUrl(gitlab, { project: 'alice/project', branch: 'feature' }, d);
    expect(url.startsWith('https://gitlab.example.com/alice/project/-/merge_requests/new?')).toBe(true);
    expect(url).toContain('merge_request%5Btarget_project_id%5D=42');
  });

  it("GitHub's compare page takes the title, body, labels and assignees; a fork heads with its owner", () => {
    expect(newMrUrl(github, { project: 'octo-org/widget', branch: 'feature/widget' }, { ...d, title: 'Add the widget', description: 'It spins.' }).url)
      .toBe('https://github.com/octo-org/widget/compare/main...feature/widget?expand=1&title=Add%20the%20widget&body=It%20spins.&labels=bug%2Cui&assignees=hubot');
    expect(newMrUrl(github, { project: 'octocat/widget', branch: 'feature' }, d).url).toContain('/compare/main...octocat:feature?');
  });

  it('past the URL limit the description is left out, and says so', () => {
    const long = newMrUrl(github, { project: 'octo-org/widget', branch: 'f' }, { ...d, description: 'x'.repeat(MAX_URL_LENGTH) });
    expect(long.withoutDescription).toBe(true);
    expect(long.url).not.toContain('body=');
    expect(long.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
  });

  it('drops labels then the title when the link is still too long, and flags it', () => {
    const r = newMrUrl(github, { project: 'octo-org/widget', branch: 'f' }, { ...d, title: 'T'.repeat(9000), labels: ['l'.repeat(100)] });
    expect(r.withoutMore).toBe(true);
    expect(r.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(r.url).not.toContain('labels=');
  });

  it('encodes a fork path', () => {
    expect(newMrUrl(gitlab, { project: 'al ice/project', branch: 'f' }, d).url).toContain('/al%20ice/project/-/merge_requests/new');
  });
});
