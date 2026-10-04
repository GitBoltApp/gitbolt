import { api } from '../../api/client';
import type { DiffSpec } from '../../api/gen/DiffSpec';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import { useRuntime } from '../../app/runtime';
import { tabStore } from '../../app/tabStores';
import { filesKey } from '../../repo/services';
import { targetFor } from '../../repo/store';
import { useToast } from '../../ui/toast';
import { mrName } from '../labels';
import { forgeOf } from '../mrStore';

/**
 * A diff-line note's `file:line` (spec #4 §2: "clicking opens that file's diff"): the file in the
 * local compare of merge-base(the target branch's remote tip, the MR's head) → the MR's head, as
 * the MR's diff is. Both commits must be in the loaded graph (fetch, or check out, first).
 */
export async function openNoteFile(tabId: string, kind: ForgeKind, mr: ForgeMr, path: string): Promise<void> {
  const say = (m: string) => useToast.getState().show(m);
  const noun = mrName(kind).toLowerCase();
  const notLoaded = `The ${noun}'s commits aren't in the loaded history: fetch, or check it out first`;
  const rt = useRuntime.getState().tabs[tabId];
  const store = tabStore(tabId);
  const remote = forgeOf(tabId).remote;
  const head = mr.headSha;
  if (!rt?.repo || !store || !remote || !head) return say(notLoaded);
  const tip = rt.sidebar?.remotes.find((g) => g.name === remote)?.branches.find((b) => b.name === mr.targetBranch)?.target;
  const base = tip ? await api.mergeBase(rt.repo.id, tip, head).catch(() => null) : null;
  if (!base || !store.getState().compareCommits(base, head)) return say(notLoaded);
  const spec: DiffSpec = { kind: 'compare', from: base, to: head };
  const list = await store.getState().services.files.get(filesKey(spec)).catch(() => null);
  const i = list ? list.files.findIndex((f) => f.path === path || f.oldPath === path) : -1;
  if (!list || i < 0) return say(`${path} isn't changed in this ${noun} any more`);
  store.getState().openFile(targetFor(list.files[i], spec), list.files.slice(i + 1, i + 2).map((f) => targetFor(f, spec)));
}
