import type { ForgeKind } from '../api/gen/ForgeKind';
import type { ForgeMr } from '../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../api/gen/ForgeMrDetail';
import type { ForgeProject } from '../api/gen/ForgeProject';
import type { ForgeUser } from '../api/gen/ForgeUser';

/** Tests only: forge data as the backend sends it. */
export const user = (name: string, email: string | null = null): ForgeUser => {
  const login = name.toLowerCase().split(' ')[0];
  return { id: login.length, username: login, name, avatarUrl: null, webUrl: `https://gitlab.example.com/${login}`, email };
};

export function mrOf(number: number, over: Partial<ForgeMr> = {}): ForgeMr {
  return {
    number, title: `MR ${number}`, state: 'open', author: user('Grace Hopper'),
    sourceProject: 'group/project', sourceBranch: 'dev', targetProject: 'group/project', targetBranch: 'main',
    headSha: String(number).padStart(40, '0'), webUrl: `https://gitlab.example.com/group/project/-/merge_requests/${number}`,
    pipeline: null, review: { decision: 'none', approvals: 0, approvalsRequired: null, reviews: [] }, conflicts: false, labels: [], updatedAt: 1_791_115_200,
    ...over,
  };
}

export function detailOf(mr: ForgeMr, over: Partial<ForgeMrDetail> = {}): ForgeMrDetail {
  return { mr, description: 'Adds the dev work.', reviewers: [], assignees: [], mergeStatus: { kind: 'mergeable' }, squash: null, deleteSourceBranch: null, ...over };
}

export function projectOf(path = 'group/project', kind: ForgeKind = 'gitlab'): ForgeProject {
  const host = kind === 'gitlab' ? 'gitlab.example.com' : 'github.com';
  const [owner, name] = [path.split('/').slice(0, -1).join('/'), path.split('/').pop() ?? path];
  return { kind, id: 42, host, path, name, owner, webUrl: `https://${host}/${path}`, defaultBranch: 'main', cloneHttps: `https://${host}/${path}.git`, cloneSsh: `git@${host}:${path}.git`, forkOf: null, updatedAt: 1, archived: false };
}
