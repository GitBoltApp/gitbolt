import { describe, expect, it } from 'vitest';
import type { CreateContext } from '../../api/gen/CreateContext';
import type { LocalBranch } from '../../api/gen/LocalBranch';
import type { MrDraft } from './draft';
import { createBlocked, createRequest, defaultTarget, defaultTemplate, freshDraft, joinDescription, pushedAs, squashToggle, withTemplate } from './prefill';

const tpl = (name: string, body = `## ${name}`) => ({ name, path: `.gitlab/merge_request_templates/${name}.md`, body });
const local = (name: string, pushTarget: string | null): LocalBranch => ({
  name, fullName: `refs/heads/${name}`, target: 'a'.repeat(40), upstream: pushTarget, ahead: 0, behind: 0, gone: false, tipTime: 0, summary: '', author: '',
  isHead: false, worktree: null, checkedOut: null, pushTarget, pushBehind: pushTarget ? 0 : null, rewritten: null,
});
const CTX: CreateContext = {
  project: {
    kind: 'gitlab', id: 42, host: 'gitlab.example.com', path: 'group/project', name: 'project', owner: 'group', webUrl: 'https://gitlab.example.com/group/project',
    defaultBranch: 'main', cloneHttps: '', cloneSsh: '', forkOf: null, updatedAt: null, archived: false,
  },
  sourceProject: 'group/project',
  settings: { mergeMethods: ['merge'], squash: 'defaultOn', deleteSourceBranch: true },
  templates: [tpl('Default'), tpl('Bug')],
  templatesLocal: false,
  firstCommit: { summary: 'Add login', body: 'Why it matters.', count: 2 },
};
const route = { sourceRemote: 'origin', targetRemote: 'origin', targetBranch: 'main' };

describe('prefill rules (spec #4 §2 "Create MR/PR", rulings 4–6, 10)', () => {
  it('the default template is the only one, else the one named Default, else none', () => {
    expect(defaultTemplate([tpl('Bug')])?.name).toBe('Bug');
    expect(defaultTemplate([tpl('Bug'), tpl('default')])?.name).toBe('default');
    expect(defaultTemplate([tpl('Bug'), tpl('Feature')])).toBeNull();
    expect(defaultTemplate([])).toBeNull();
  });

  it('the description is the first commit body, a blank line, then the template', () => {
    expect(joinDescription('Why.', tpl('Default'))).toBe('Why.\n\n## Default');
    expect(joinDescription('', tpl('Default'))).toBe('## Default');
    expect(joinDescription('Why.\n', null)).toBe('Why.');
  });

  it("squash follows the project, locked when it says always or never", () => {
    expect(squashToggle({ ...CTX.settings, squash: 'always' })).toEqual({ value: true, locked: true, caption: 'This project always squashes' });
    expect(squashToggle({ ...CTX.settings, squash: 'never' })).toEqual({ value: false, locked: true, caption: "This project doesn't allow squashing" });
    expect(squashToggle({ ...CTX.settings, squash: 'defaultOn' })).toEqual({ value: true, locked: false, caption: null });
    expect(squashToggle({ ...CTX.settings, squash: 'defaultOff' })).toEqual({ value: false, locked: false, caption: null });
  });

  it('a branch is pushed as its push target says, the longest remote name winning', () => {
    expect(pushedAs(local('feature', 'origin/feature/x'), ['origin', 'up'])).toEqual({ remote: 'origin', branch: 'feature/x' });
    expect(pushedAs(local('feature', 'team/fork/feature'), ['team', 'team/fork'])).toEqual({ remote: 'team/fork', branch: 'feature' });
    expect(pushedAs(local('feature', null), ['origin'])).toBeNull();
    expect(pushedAs(undefined, ['origin'])).toBeNull();
  });

  it('the target is the branch below in a stack, else the project default', () => {
    const stack = { branches: ['a', 'b', 'c'], base: 'refs/remotes/origin/main', leftBehind: [] };
    const locals = [local('a', 'origin/team-a'), local('b', 'origin/b')];
    expect(defaultTarget('b', stack, locals, ['origin'], 'main')).toBe('team-a');
    expect(defaultTarget('c', stack, locals, ['origin'], 'main')).toBe('b');
    expect(defaultTarget('a', stack, locals, ['origin'], 'main')).toBe('main');
    expect(defaultTarget('x', null, locals, ['origin'], 'develop')).toBe('develop');
    expect(defaultTarget('x', null, locals, ['origin'], null)).toBe('main');
  });

  it('a fresh draft takes the first commit, the default template and the project defaults', () => {
    const fresh = freshDraft(CTX, route);
    expect(fresh).toMatchObject({ ...route, title: 'Add login', description: 'Why it matters.\n\n## Default', template: CTX.templates[0].path, squash: true, deleteSourceBranch: true, draft: false });
    expect(fresh.prefilled).toBe(fresh.description);
    const github = freshDraft({ ...CTX, project: { ...CTX.project, kind: 'github' }, firstCommit: null }, route);
    expect([github.title, github.squash, github.deleteSourceBranch]).toEqual(['', null, null]);
  });

  it('a template replaces an untouched description silently, an edited one only after asking', () => {
    const fresh = freshDraft(CTX, route);
    const swapped = withTemplate(fresh, CTX, CTX.templates[1]);
    expect(swapped.edited).toBe(false);
    expect(swapped.draft.description).toBe('Why it matters.\n\n## Bug');
    expect(swapped.draft.template).toBe(CTX.templates[1].path);
    expect(withTemplate({ ...fresh, description: 'mine' }, CTX, null)).toMatchObject({ edited: true, draft: { description: 'Why it matters.', template: null } });
  });

  it('the request carries ids, the trimmed title, and squash only while the project leaves it open', () => {
    const d: MrDraft = { ...freshDraft(CTX, route), title: ' Add login ', reviewers: [{ id: 8, username: 'grace', name: 'Grace', avatarUrl: null, webUrl: '', email: null }], labels: ['bug'] };
    expect(createRequest(d, CTX, 'feature/login')).toEqual({
      source: { project: 'group/project', branch: 'feature/login' }, targetBranch: 'main', title: 'Add login', description: 'Why it matters.\n\n## Default',
      draft: false, reviewers: [8], assignees: [], labels: ['bug'], squash: true, deleteSourceBranch: true,
    });
    expect(createRequest(d, { ...CTX, settings: { ...CTX.settings, squash: 'always' } }, 'f').squash).toBeNull();
    expect(createRequest(d, { ...CTX, project: { ...CTX.project, kind: 'github' } }, 'f')).toMatchObject({ squash: null, deleteSourceBranch: null });
  });

  it('says why Create is blocked: not pushed, onto itself, no title', () => {
    const d = freshDraft(CTX, route);
    const at = { draft: d, sourceBranch: 'feature', onRemote: true, sourceProject: 'group/project', targetProject: 'group/project' };
    expect(createBlocked(at)).toBeNull();
    expect(createBlocked({ ...at, onRemote: false })).toBe('Push feature to origin first');
    expect(createBlocked({ ...at, sourceBranch: 'main' })).toBe("main can't target itself");
    expect(createBlocked({ ...at, sourceBranch: 'main', sourceProject: 'alice/project' })).toBeNull();
    expect(createBlocked({ ...at, draft: { ...d, title: '  ' } })).toBe('Enter a title');
  });
});
