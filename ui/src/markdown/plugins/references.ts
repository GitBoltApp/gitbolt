import type { Root } from 'mdast';
import { findAndReplace, type FindAndReplaceList, type ReplaceFunction } from 'mdast-util-find-and-replace';
import type { MdFlavor, MdReferenceNode } from '../types';

/** Bounded (GitHub's 100 characters a segment, GitLab's 20 levels of subgroups): unbounded
 * segments backtracked quadratically on long runs of `.` or `-a`. The lookbehinds below also
 * exclude `.` and `-`, so a match never starts inside a longer segment. */
const SEG = '[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}';
/** GitHub: `owner/repo`; GitLab: `group/sub/project`. */
const PROJECT: Record<MdFlavor, string> = { github: `${SEG}/${SEG}`, gitlab: `${SEG}(?:/${SEG}){1,20}` };

const node = (refKind: MdReferenceNode['refKind'], value: string, over: Partial<MdReferenceNode>): MdReferenceNode => ({ type: 'reference', refKind, project: null, number: null, sha: null, user: null, value, ...over });

const issueOrMr = (refKind: 'issue' | 'mr'): ReplaceFunction => (value: string, project: string | undefined, num: string) => {
  const n = Number(num);
  return n > 0 && Number.isSafeInteger(n) ? node(refKind, value, { project: project ?? null, number: n }) : false;
};

/** 7–40 hex digits with a letter and a digit, or 40 digits (spec §3.1). */
const sha: ReplaceFunction = (value: string) => ((/[a-f]/.test(value) && /\d/.test(value)) || value.length === 40 ? node('commit', value, { sha: value }) : false);
const mention: ReplaceFunction = (value: string, user: string) => node('mention', value, { user });

/** `#123`, `owner/repo#123`, GitLab's `!45` / `group/project!45` (gitlab flavor), SHAs and
 * `@user` as `reference` nodes. Text inside links, inline code and code blocks is never visited
 * (GFM's autolinked URLs are links). */
export function remarkReferences({ flavor }: { flavor: MdFlavor }) {
  return (tree: Root) => {
    // Fresh global regexes per run: a shared one would carry its lastIndex across documents.
    const issue = new RegExp(`(?<![\\w/#&.-])(?:(${PROJECT[flavor]}))?#(\\d+)(?![\\w#])`, 'g');
    const mr = new RegExp(`(?<![\\w/!.-])(?:(${PROJECT.gitlab}))?!(\\d+)(?![\\w!])`, 'g');
    const shas = /(?<![\w@/.#-])[0-9a-f]{7,40}(?![\w-])/g;
    const mentions = /(?<![\w`@/.+-])@([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)(?![\w@])/g;
    const list: FindAndReplaceList = [[issue, issueOrMr('issue')], [mentions, mention], [shas, sha]];
    if (flavor === 'gitlab') list.unshift([mr, issueOrMr('mr')]);
    findAndReplace(tree, list, { ignore: ['link', 'linkReference'] });
  };
}
