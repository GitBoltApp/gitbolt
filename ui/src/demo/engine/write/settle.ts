// A paused merge, rebase or pick settles once nothing is in progress any more (run_write's
// settle_paused, §13.2): completed or aborted by the core's `completed` (write/mod.rs), its moves
// recorded either way. Steps 2b (it ended outside GitVolt) and 7b (this write started mid-operation:
// Commit, Continue, Abort); its autostash is restored either way. Not here: the core's leftover
// `.git/sequencer` quit (the demo's picks keep no git sequencer).
import type { ReadRepo } from '../read/seam';
import { compareBytewise } from '../read/bytes';
import { readCommit } from '../read/commitText';
import { ancestors, isAncestor } from '../read/revs';
import { inProgressName } from './inProgress';
import type { JournalEntry, PausedOp } from './journal';
import { rawAuthor } from './objects';
import { readHead, readRef, type RefMove } from './refs';
import { restoreAutostash, settleAutostash } from './autostash';
import { recordRewrite, type WriteCx } from './run';

/** The write that may complete the paused op: its journal entry and the refs it moved itself. */
export interface Completing {
  entry: number | null;
  moves: RefMove[];
}

/** The commits `tip` has beyond `base`. */
async function beyond(repo: ReadRepo, tip: string, base: string): Promise<string[]> {
  const hidden = await ancestors(repo, base);
  return [...(await ancestors(repo, tip))].filter((c) => !hidden.has(c));
}

/** Per commit what a rebase or pick keeps of it: its author's email and time (not the message: a
 *  Continue may reword it). From the author line as stored, `<email> <seconds> <zone>`. */
export const keyOf = async (repo: ReadRepo, oid: string): Promise<string> => {
  const line = await rawAuthor(repo, oid);
  return line.slice(line.lastIndexOf('<'));
};
const authoredOf = async (repo: ReadRepo, oids: string[]) => new Set(await Promise.all(oids.map((o) => keyOf(repo, o))));

/** `message` says "This reverts commit <hex>", 7 hex digits or more, of one of `oids`. */
function revertsOneOf(message: string, oids: string[]): boolean {
  for (const m of message.matchAll(/This reverts commit ([0-9a-fA-F]*)/g)) {
    const hex = m[1].toLowerCase();
    if (hex.length >= 7 && oids.some((o) => o.toLowerCase().startsWith(hex))) return true;
  }
  return false;
}

/** The core's `completed`: the paused op ended as itself (else it was aborted). `inside`: the write
 *  that ended it is GitVolt's own (a Commit or Continue). */
async function completed(cx: WriteCx, entry: JournalEntry, op: PausedOp, now: Map<string, string | null>, inside: boolean): Promise<boolean> {
  const branch = entry.headBefore.branch;
  if (branch === null) return false;
  const name = `refs/heads/${branch}`;
  const old = op.refsBefore.get(name) ?? null;
  const tip = now.get(name) ?? null;
  if (old === null || tip === null || old === tip) return false;
  const repo = cx.wt.repo;
  switch (op.kind) {
    case 'merge': {
      const parents = (await readCommit(repo, tip)).parents;
      return parents.length >= 2 && parents[0] === old && (op.targetOid === null || parents.slice(1).includes(op.targetOid));
    }
    case 'rebase': {
      // The branch moved onto its target, keeping only commits it had (or made at a stop).
      const target = op.targetOid;
      if (target === null || !((inside || tip !== target) && (await isAncestor(repo, target, tip)) && !(await isAncestor(repo, old, tip)))) return false;
      const theirs = new Set([...(await authoredOf(repo, await beyond(repo, old, target))), ...(await authoredOf(repo, op.irebase?.made ?? []))]);
      return [...(await authoredOf(repo, await beyond(repo, tip, target)))].every((k) => theirs.has(k));
    }
    case 'cherryPick': {
      // Only the pick's own commits on top of the old tip (an abort and new work there isn't).
      if (!(await isAncestor(repo, old, tip))) return false;
      const picked = await authoredOf(repo, op.picked);
      return [...(await authoredOf(repo, await beyond(repo, tip, old)))].every((k) => picked.has(k));
    }
    case 'revert': {
      if (!(await isAncestor(repo, old, tip))) return false;
      const made = await beyond(repo, tip, old);
      if (made.length > op.picked.length) return false;
      // GitVolt's own Continue commits the message the user may have rewritten; ended outside it,
      // each new commit must say what it reverts.
      if (inside) return true;
      for (const c of made) if (!revertsOneOf((await readCommit(repo, c)).rawMessage, op.picked)) return false;
      return true;
    }
  }
}

async function settle(cx: WriteCx, completing: Completing | null): Promise<{ restored: string | null }> {
  const j = cx.journal;
  const entry = j.paused();
  const op = entry?.paused;
  if (!entry || !op || inProgressName(cx.wt.fs, cx.wt.gitdir) !== null) return { restored: null };
  const now = new Map([...op.refsBefore.keys()].sort(compareBytewise).map((n) => [n, readRef(cx.wt.demo, n)] as const));
  const done = await completed(cx, entry, op, now, completing !== null);
  const branch = entry.headBefore.branch === null ? null : `refs/heads/${entry.headBefore.branch}`;
  let headAfter = entry.headBefore;
  const moves: RefMove[] = [];
  if (done) {
    headAfter = readHead(cx.wt);
    const tip = branch === null ? null : (now.get(branch) ?? null);
    const reach = tip === null ? new Set<string>() : await ancestors(cx.wt.repo, tip);
    for (const [name, value] of now) {
      const old = op.refsBefore.get(name) ?? null;
      if (old === value) continue;
      // A ref besides the branch counts only if it moved into the new history.
      if (name === branch || (value !== null && reach.has(value))) moves.push({ name, old, new: value });
    }
  }
  // An interactive rebase's Continue recorded the refs it moved as it went (chips, deletes): they're
  // this entry's in either verdict, so its Undo puts them back.
  for (const m of op.irebase?.moved ?? []) if (!moves.some((x) => x.name === m.name)) moves.push(m);
  // The Commit that completed it is absorbed when it made that commit and holds no snapshot.
  if (completing && done && cx.snapshot === null && cx.after === null && completing.entry !== null) {
    const madeIt = completing.moves.some((m) => m.name === branch && m.new === headAfter.oid);
    const own = j.entry(completing.entry);
    if (madeIt && own && own.before === null && own.after === null) j.dropEntry(completing.entry);
  }
  // A rebase that completed is a rewrite, whichever write ended it.
  if (done && op.kind === 'rebase') await recordRewrite(cx.ctx, cx.wt, 'rebase', moves);
  j.settle(entry.id, headAfter, moves);
  cx.journalChanged = true;
  // Its autostash comes back, completed or aborted; claimed first (pending), so no banner acts on it.
  const k = op.autostash === null ? null : j.keptById(op.autostash);
  if (!k || k.reason.status !== 'paused' || k.oid === null) return { restored: null };
  k.reason = { status: 'pending' };
  const st = { id: k.id, oid: k.oid, message: k.message, label: k.label, target: k.target };
  settleAutostash(cx, st, await restoreAutostash(cx, st.oid, st.message, true));
  return { restored: entry.label };
}

/** Settles the worktree's paused merge if it's no longer in progress; a failure to read what it
 *  needs leaves it waiting, as the core logs and goes on. */
export async function settlePaused(cx: WriteCx, completing: Completing | null): Promise<{ restored: string | null }> {
  try {
    return await settle(cx, completing);
  } catch {
    return { restored: null };
  }
}
