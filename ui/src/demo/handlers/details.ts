import type { LastPushKind } from '../../api/gen/LastPushKind';
import type { PersonPayload } from '../../api/gen/PersonPayload';
import type { SignaturePayload } from '../../api/gen/SignaturePayload';
import type { HandlerTable } from '../transport';
import { parseReflog } from '../engine/reflog';
import { coAuthors, commitMessage, parseOid, readCommit, type Person } from '../engine/read/commitText';
import { mergeBaseOf, peelToCommit, resolveRefName } from '../engine/read/revs';
import { fail, readRepoOf, readTextOrNull, type ReadRepo } from '../engine/read/seam';
import { remotePayloads } from './repo';

const UNSIGNED: SignaturePayload = { kind: 'unsigned', signer: '', key: '', fingerprint: '', trust: '', detail: null };
const person = (p: Person): PersonPayload => ({ name: p.name, email: p.email, time: p.time });

/** A commit id for merge-base: a full ref name (`refs/…`, which must exist and reach a commit) or a full hex id. */
async function commitOf(repo: ReadRepo, s: string): Promise<string> {
  const name = s.trim();
  if (name.startsWith('refs/')) {
    const target = await resolveRefName(repo, name);
    if (!target) fail('NotFound', `${name} doesn't exist`);
    const commit = await peelToCommit(repo, target);
    if (!commit) fail('NotFound', `${name} doesn't point at a commit`);
    return commit;
  }
  if (!/^[0-9a-fA-F]{40}$/.test(name)) fail('InvalidInput', `${name} isn't a commit id`);
  return name.toLowerCase();
}

export const detailsHandlers: Pick<HandlerTable, 'commitDetails' | 'commitMessage' | 'signature' | 'remotes' | 'mergeBase' | 'lastPush'> = {
  commitDetails: async ({ repo: id, id: commit }, ctx) => {
    const oid = parseOid(commit);
    const c = await readCommit(readRepoOf(ctx, id), oid);
    return { id: oid, parents: c.parents, author: person(c.author), committer: person(c.committer), coAuthors: coAuthors(c.message), signed: c.signed };
  },
  commitMessage: async ({ repo: id, id: commit }, ctx) => {
    const oid = parseOid(commit);
    return commitMessage(await readCommit(readRepoOf(ctx, id), oid), oid);
  },
  // No keys in a browser, so a signed commit is reported as one the demo can't check.
  signature: async ({ repo: id, id: commit }, ctx) => {
    const c = await readCommit(readRepoOf(ctx, id), parseOid(commit));
    return c.signed ? { ...UNSIGNED, kind: 'unverified', detail: "Signatures aren't checked in the demo" } : UNSIGNED;
  },
  remotes: async ({ repo: id }, ctx) => remotePayloads(ctx.repos.get(id)),
  mergeBase: async ({ repo: id, a, b }, ctx) => {
    const repo = readRepoOf(ctx, id);
    const x = await commitOf(repo, a);
    const y = await commitOf(repo, b);
    return mergeBaseOf(repo, x, y);
  },
  lastPush: async ({ repo: id, remoteRef }, ctx) => {
    if (!remoteRef.startsWith('refs/remotes/') || remoteRef.split('/').some((c) => c === '..' || c === '')) fail('InvalidInput', `not a remote-tracking ref: ${remoteRef}`);
    const repo = readRepoOf(ctx, id);
    const entries = parseReflog((await readTextOrNull(repo, `${repo.gitdir}/logs/${remoteRef}`)) ?? '');
    const find = (prefix: string, kind: LastPushKind) => {
      const e = entries.find((x) => x.message.startsWith(prefix));
      return e ? { time: e.time, kind } : null;
    };
    return find('update by push', 'push') ?? find('fetch', 'fetch') ?? find('pull', 'fetch');
  },
};
