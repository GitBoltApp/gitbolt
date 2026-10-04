import type { ForgeProject } from '../../api/gen/ForgeProject';
import type { MrDraft } from './draft';

/** Past this, a browser or the forge may refuse the link (ruling 14). */
export const MAX_URL_LENGTH = 8000;

const segments = (s: string) => s.split('/').map(encodeURIComponent).join('/');
const query = (pairs: Array<[string, string]>) => pairs.filter(([, v]) => v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const DRAFT_MARK = /^\s*(draft:|\[draft\]|\(draft\))/i;

/**
 * The forge's own new-MR/PR page, prefilled where its URL takes it (spec #4 §4 "4C"): GitLab the
 * branches, title (a draft as its `Draft: ` prefix) and description, opened on the source project
 * for a fork; GitHub the compare range, title, body, labels and assignees. Reviewers and GitHub's
 * draft don't travel. Past `MAX_URL_LENGTH` the description is left out (`withoutDescription`).
 */
export function newMrUrl(target: ForgeProject, source: { project: string; branch: string }, d: MrDraft): { url: string; withoutDescription: boolean; withoutMore?: boolean } {
  const fork = source.project !== target.path;
  const build = (description: string, labels = d.labels, titleText = d.title): string => {
    if (target.kind === 'gitlab') {
      const base = fork && target.webUrl.endsWith(target.path) ? `${target.webUrl.slice(0, -target.path.length)}${segments(source.project)}` : target.webUrl;
      const title = d.draft && !DRAFT_MARK.test(titleText) && titleText ? `Draft: ${titleText.trim()}` : titleText.trim();
      return `${base}/-/merge_requests/new?${query([
        ['merge_request[source_branch]', source.branch],
        ...(fork ? [['merge_request[target_project_id]', String(target.id)] as [string, string]] : []),
        ['merge_request[target_branch]', d.targetBranch],
        ['merge_request[title]', title],
        ['merge_request[description]', description],
      ])}`;
    }
    const owner = source.project.split('/')[0];
    const head = fork ? `${encodeURIComponent(owner)}:${segments(source.branch)}` : segments(source.branch);
    return `${target.webUrl}/compare/${segments(d.targetBranch)}...${head}?${query([
      ['expand', '1'], ['title', titleText.trim()], ['body', description], ['labels', labels.join(',')], ['assignees', d.assignees.map((u) => u.username).join(',')],
    ])}`;
  };
  const full = build(d.description);
  if (full.length <= MAX_URL_LENGTH || !d.description) return { url: full, withoutDescription: false };
  const noDesc = build('');
  if (noDesc.length <= MAX_URL_LENGTH) return { url: noDesc, withoutDescription: true };
  const noLabels = build('', []);
  if (noLabels.length <= MAX_URL_LENGTH) return { url: noLabels, withoutDescription: true, withoutMore: true };
  return { url: build('', [], ''), withoutDescription: true, withoutMore: true };
}
