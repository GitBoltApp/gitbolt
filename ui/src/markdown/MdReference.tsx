import type { ReactNode } from 'react';
import { api } from '../api/client';
import type { ForgeUser } from '../api/gen/ForgeUser';
import { useRuntime } from '../app/runtime';
import { ForgeAvatar } from '../avatars/Avatar';
import { forgeOf } from '../forge/mrStore';
import { browserUrlFor, resolveReference } from './links';
import { LinkView } from './MdLink';
import type { MarkdownContext, MdReferenceProps } from './types';

const users = new Map<string, Promise<ForgeUser | null>>();

/** `@user`'s hover card: avatar and name from the forge user lookup (4C's `forgeSearchUsers`), once per session. */
export function userCard(ctx: MarkdownContext, username: string): Promise<ReactNode> {
  const repo = useRuntime.getState().tabs[ctx.tabId]?.repo?.id;
  const remote = forgeOf(ctx.tabId).remote;
  const key = `${repo}\0${remote}\0${username.toLowerCase()}`;
  let p = users.get(key);
  if (!p) {
    p = repo === undefined || !remote ? Promise.resolve(null) : api.forgeSearchUsers(repo, remote, username).then((list) => list.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? null);
    users.set(key, p);
    p.catch(() => users.delete(key));
  }
  return p.then(
    (u) => (u ? <span className="md-user-card"><ForgeAvatar user={u} size={24} /><span><b>{u.name}</b> <span className="md-user-login">@{u.username}</span></span></span> : `@${username}`),
    () => `@${username}`,
  );
}

export function MdReference({ ctx, node }: MdReferenceProps) {
  const target = resolveReference(ctx, node);
  const href = browserUrlFor(ctx, target) ?? '';
  if (node.refKind === 'mention' && node.user) {
    const user = node.user;
    return <LinkView ctx={ctx} target={target} href={href} className="md-ref md-mention" tooltip={() => userCard(ctx, user)}>{node.value}</LinkView>;
  }
  return <LinkView ctx={ctx} target={target} href={href} className="md-ref">{node.value}</LinkView>;
}
