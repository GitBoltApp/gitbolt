import { useCallback, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { ForgeUser } from '../api/gen/ForgeUser';
import { useRuntime } from '../app/runtime';
import { ForgeAvatar } from '../avatars/Avatar';
import { useForge } from '../forge/mrStore';
import { peopleSource } from '../forge/pickerCache';
import { findTrigger, loadEmojiList, rankEmoji, type EmojiEntry, type EmojiHit } from './emojiComplete';
import { findMention, mergePeople, participantsOf, rankPeople } from './mentions';
import type { Provider } from './useCompletion';

/** `:shortcode` → gemoji's emoji; inserts the shortcode, not the glyph (both forges and GitBolt's
 * own renderer turn it into the emoji). */
export function useEmojiProvider(): Provider<EmojiHit> {
  const [list, setList] = useState<readonly EmojiEntry[] | null>(null);
  const prepare = useCallback(() => { void loadEmojiList().then(setList, () => undefined); }, []);
  return useMemo<Provider<EmojiHit>>(() => ({
    label: 'Emoji',
    find: findTrigger,
    local: (q) => (list ? rankEmoji(list, q) : []),
    prepare,
    key: (h) => h.name,
    token: (h) => `:${h.name}: `,
    row: (h) => <><span className="md-emoji-glyph" aria-hidden>{h.emoji}</span><span>:{h.name}:</span></>,
  }), [list, prepare]);
}

/** `@username` from the forge's people search (the reviewer picker's cached one), the MR/PR's own
 * people first; null (no popup) when the tab has no forge project. */
export function useMentionProvider(tabId: string): Provider<ForgeUser> | null {
  const repoId = useRuntime((s) => s.tabs[tabId]?.repo?.id);
  const remote = useForge((s) => s.byTab[tabId]?.remote ?? null);
  const hasProject = useForge((s) => s.byTab[tabId]?.project != null);
  const openMr = useForge((s) => s.byTab[tabId]?.openMr ?? null);
  const detail = useForge((s) => (openMr === null ? undefined : s.byTab[tabId]?.details[openMr]?.value));
  const listed = useForge((s) => (openMr === null ? undefined : s.byTab[tabId]?.list?.mrs.find((m) => m.number === openMr)));
  const discussions = useForge((s) => (openMr === null ? undefined : s.byTab[tabId]?.discussions[openMr]));
  const participants = useMemo(
    () => participantsOf([(detail?.mr ?? listed)?.author, ...(detail?.reviewers ?? []), ...(detail?.assignees ?? []), ...(discussions ?? []).flatMap((d) => d.notes.filter((x) => !x.system).map((x) => x.author))]),
    [detail, listed, discussions],
  );
  return useMemo<Provider<ForgeUser> | null>(() => {
    if (repoId === undefined || !remote || !hasProject) return null;
    const source = peopleSource<ForgeUser>(repoId, remote, (q) => api.forgeSearchUsers(repoId, remote, q));
    const found = (q: string) => source.peek(q)?.items ?? [];
    return {
      label: 'People',
      find: findMention,
      local: (q) => mergePeople(rankPeople(participants, q), rankPeople(found(q), q)),
      remote: (q) => source.load(q).then((r) => mergePeople(participants.length ? rankPeople(participants, q) : [], r)),
      key: (u) => String(u.id),
      token: (u) => `@${u.username} `,
      row: (u) => <><ForgeAvatar user={u} size={18} /><span>{u.name}</span><span className="md-mention-handle">@{u.username}</span></>,
    };
  }, [repoId, remote, hasProject, participants]);
}
