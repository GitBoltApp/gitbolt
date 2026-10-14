// Stacked merge requests (the core's forge/stack.rs), on the demo's GitLab: the stack view, the
// Stack table kept in each open MR's description, retargeting, and the merge guard. The demo's
// GitLab is 18.9.1, so stacks are managed (GitVolt keeps the table); GitLab 19.1 links them itself.
// GitLab only: `!n`, the noun `MR`.
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { GbError } from '../../api/gen/GbError';
import { gbError } from '../engine/errors';
import type { MrPrefill } from '../../api/gen/MrPrefill';
import type { MrState } from '../../api/gen/MrState';
import type { StackMode } from '../../api/gen/StackMode';
import type { StackSync } from '../../api/gen/StackSync';
import type { StackView } from '../../api/gen/StackView';
import type { ForgeProject } from '../../api/gen/ForgeProject';
import type { DemoContext } from '../context';
import { readCommit } from '../engine/read/commitText';
import { ancestors, revParse } from '../engine/read/revs';
import { fail, isGbError, type ReadRepo } from '../engine/read/seam';
import { describeNew } from './gitEffects';
import { type DemoForge, projectForRemote, repoProjects, type Remotes, wrote } from './hub';
import { MARK_END, MARK_START } from './gitlabJson';

export { MARK_END, MARK_START };

/** GitLab's native stacked merge requests (version.rs `NATIVE_STACKS_GITLAB`). */
const NATIVE_STACKS_GITLAB: [number, number] = [19, 1];

/** version.rs `version_at_least`: `19.1.0-ee` is at least 19.1; unreadable is no. */
export function versionAtLeast(version: string, major: number, minor: number): boolean {
  const [a, b] = version.trim().split(/[.-]/);
  if (!/^\d+$/.test(a ?? '') || !/^\d+$/.test(b ?? '')) return false;
  return Number(a) > major || (Number(a) === major && Number(b) >= minor);
}

/** `mr_ref` for GitLab. */
export const mrRef = (n: number): string => `!${n}`;

const STATE_WORD: Record<MrState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', merging: 'Merging', closed: 'Closed' };

/** `escape_cell`: one line; Markdown's table and emphasis characters escaped; `<` and `>` as entities. */
function escapeCell(title: string): string {
  const line = title.split(/[\r\n]/).map((s) => s.trim()).filter((s) => s !== '').join(' ');
  let out = '';
  for (const c of line) out += '\\|*_`[]'.includes(c) ? `\\${c}` : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c;
  return out;
}

/** `eol_of`: CRLF when the description has one, else LF. */
export const eolOf = (description: string): '\r\n' | '\n' => (description.includes('\r\n') ? '\r\n' : '\n');

/** `render_block`: the marker-fenced Stack table, bottom to top, `current`'s row in bold. */
export function renderBlock(rows: { number: number; title: string; state: MrState }[], current: number, eol: string): string {
  const lines = [MARK_START, '**Stack** (kept up to date by GitVolt)', '', '| # | MR | Title | State |', '|---|---|---|---|'];
  rows.forEach((r, i) => {
    const cells = [String(i + 1), mrRef(r.number), escapeCell(r.title), STATE_WORD[r.state]];
    lines.push(`| ${(r.number === current ? cells.map((c) => (c === '' ? '' : `**${c}**`)) : cells).join(' | ')} |`);
  });
  lines.push(MARK_END);
  return lines.join(eol);
}

/** `splice_block`: `block` in place of the description's first complete block (an end marker and
 * the last start marker before it); later complete blocks go; dangling markers are text. Without a
 * block it is appended after a blank line. Every byte outside the markers is kept. */
export function spliceBlock(description: string, block: string): string {
  const spans: [number, number][] = [];
  let from = 0;
  for (;;) {
    const found = description.indexOf(MARK_END, from);
    if (found < 0) break;
    const end = found + MARK_END.length;
    const s = description.slice(from, found).lastIndexOf(MARK_START);
    if (s >= 0) spans.push([from + s, end]);
    from = end;
  }
  if (spans.length === 0) {
    if (description === '') return block;
    const eol = eolOf(description);
    return description + (description.endsWith('\n') ? eol : eol + eol) + block;
  }
  let out = description.slice(0, spans[0][0]) + block;
  let at = spans[0][1];
  for (const [s, e] of spans.slice(1)) {
    out += description.slice(at, s);
    at = e;
  }
  return out + description.slice(at);
}

/** `prefills`: each member's oldest commit beyond the member below (the bottom: beyond `baseRef`) as
 * a new MR's title and description; null for a branch that's missing or has no commit of its own. */
export async function prefills(read: ReadRepo, root: string, branches: string[], baseRef: string): Promise<(MrPrefill | null)[]> {
  const id = (r: string) => revParse(read, `${r}^{commit}`, root).catch(() => null);
  let below = await id(baseRef);
  const out: (MrPrefill | null)[] = [];
  for (const b of branches) {
    const tip = await id(`refs/heads/${b}`);
    let first: string | null = null;
    if (tip !== null && below !== null) {
      // Breadth first from the tip, the commits `below` reaches hidden: the last one reached is the oldest.
      const hidden = await ancestors(read, below);
      const seen = new Set<string>();
      for (const queue = [tip]; queue.length > 0; ) {
        const at = queue.shift()!;
        if (seen.has(at) || hidden.has(at)) continue;
        seen.add(at);
        first = at;
        queue.push(...(await readCommit(read, at)).parents);
      }
    }
    let prefill: MrPrefill | null = null;
    if (first !== null) {
      const message = (await readCommit(read, first)).rawMessage.trimEnd();
      const nl = message.indexOf('\n');
      const [subject, rest] = nl < 0 ? [message, ''] : [message.slice(0, nl), message.slice(nl + 1)];
      prefill = { title: subject.trim(), description: rest.replace(/^[\r\n]+/, '').trimEnd() };
    }
    below = tip ?? below;
    out.push(prefill);
  }
  return out;
}

/** What the stack requests act on: the repo's target project and the stack's mode. */
async function stackCtx(f: DemoForge, r: Remotes): Promise<{ remote: string; project: ForgeProject; mode: StackMode }> {
  const remote = (await repoProjects(f, r)).target ?? fail('InvalidInput', 'This repository has no forge project: add an account in Settings › Accounts');
  const project = await projectForRemote(f, r, remote);
  const native = project.kind === 'gitlab' && versionAtLeast(f.fake.seed.version, ...NATIVE_STACKS_GITLAB);
  return { remote, project, mode: native ? 'native' : 'managed' };
}

/** `member_mrs`: each branch's MR in the target project (an open or draft one before a newer closed one). */
function memberMrs(f: DemoForge, project: ForgeProject, branches: string[]): (ForgeMr | null)[] {
  return branches.map((branch) => f.provider.mrForBranch(project, { project: project.path, branch }));
}

/** `stack_view`: `branches` bottom to top; `base`: the branch the bottom one targets; `prefills`
 * are kept only where a new MR is needed. */
export async function stackView(f: DemoForge, r: Remotes, branches: string[], base: string, prefills: (MrPrefill | null)[]): Promise<StackView> {
  const c = await stackCtx(f, r);
  const mrs = memberMrs(f, c.project, branches);
  const members = branches.map((branch, i) => ({
    branch,
    targetBranch: i === 0 ? base : branches[i - 1],
    mr: mrs[i],
    prefill: mrs[i] === null || mrs[i]!.state === 'closed' ? (prefills[i] ?? null) : null,
  }));
  return { remote: c.remote, project: c.project.path, kind: c.project.kind, mode: c.mode, members };
}

const isOpen = (m: ForgeMr) => m.state === 'open' || m.state === 'draft';

/** `sync_stack`: the Stack table rewritten in every open MR of a managed stack; an unchanged
 * description isn't sent, and one failure doesn't stop the others. */
export async function syncStack(f: DemoForge, r: Remotes, branches: string[]): Promise<StackSync> {
  const c = await stackCtx(f, r);
  const mrs = memberMrs(f, c.project, branches).flatMap((m) => m ?? []);
  const sync: StackSync = { edited: [], unchanged: [], failed: [] };
  if (c.mode === 'native') {
    sync.unchanged = mrs.filter(isOpen).map((m) => m.number);
    return sync;
  }
  for (const m of mrs.filter(isOpen)) {
    try {
      const description = f.provider.mrDetail(c.project, m.number).description;
      const next = spliceBlock(description, renderBlock(mrs, m.number, eolOf(description)));
      if (next === description) sync.unchanged.push(m.number);
      else {
        f.provider.edit(c.project, m.number, { title: null, description: next, labels: null });
        sync.edited.push(m.number);
      }
    } catch (e) {
      if (!isGbError(e)) throw e;
      sync.failed.push({ number: m.number, message: e.message });
    }
  }
  return sync;
}

/** `retarget_mr`: MR `n` pointed at `target`; the forgotten lists, and the diffs rebuilt against the new base. */
export async function retargetMr(f: DemoForge, r: Remotes, n: number, target: string, ctx: DemoContext): Promise<ForgeMr> {
  const c = await stackCtx(f, r);
  const mr = f.provider.retarget(c.project, n, target);
  wrote(f, c.project.path);
  await describeNew(ctx, f, c.project.path, n);
  return mr;
}

/** What `beforeMerge` retargeted, for `mergeFailed`. */
export interface MergeGuard { from: string; to: string; moved: number[] }

const NO_GUARD = (): MergeGuard => ({ from: '', to: '', moved: [] });

function appendStuck(message: string, stuck: number[], to: string): string {
  if (stuck.length === 0) return message;
  return `${message} (${stuck.map(mrRef).join(', ')} still target${stuck.length === 1 ? 's' : ''} ${to})`;
}

/** `before_merge`: before MR `n` merges and its source branch is deleted, the open MRs that target
 * that branch are pointed at its target (a managed stack only; a fork's merge deletes a branch in
 * the fork). `deletesBranch` null follows the project's setting. One failure puts the moved ones back. */
export async function beforeMerge(f: DemoForge, r: Remotes, n: number, deletesBranch: boolean | null, ctx: DemoContext): Promise<MergeGuard> {
  const c = await stackCtx(f, r);
  if (c.mode === 'native') return NO_GUARD();
  let deletes = deletesBranch;
  if (deletes === null) {
    try {
      deletes = f.provider.projectSettings(c.project).deleteSourceBranch;
    } catch (e) {
      if (!isGbError(e)) throw e;
      throw gbError(e.kind, `Not merged: couldn't read ${c.project.path}'s merge settings: ${e.message}`);
    }
  }
  if (!deletes) return NO_GUARD();
  const merging = f.provider.mrDetail(c.project, n).mr;
  if (merging.sourceProject !== merging.targetProject) return NO_GUARD();
  const dependents = f.provider.openMrsTargeting(c.project, merging.sourceBranch)
    .filter((m) => m.number !== n && m.targetBranch === merging.sourceBranch && m.targetProject === merging.targetProject)
    .map((m) => m.number);
  const guard: MergeGuard = { from: merging.sourceBranch, to: merging.targetBranch, moved: [] };
  for (const d of dependents) {
    try {
      f.provider.retarget(c.project, d, merging.targetBranch);
    } catch (e) {
      if (!isGbError(e)) throw e;
      const stuck = await afterFailedMerge(f, r, guard, ctx);
      throw gbError(e.kind, appendStuck(`Not merged: couldn't retarget ${mrRef(d)} first (${e.message})`, stuck, guard.to));
    }
    guard.moved.push(d);
  }
  return guard;
}

/** `after_failed_merge`: the moved MRs point back; returns the ones that couldn't be. */
async function afterFailedMerge(f: DemoForge, r: Remotes, guard: MergeGuard, ctx: DemoContext): Promise<number[]> {
  if (guard.moved.length === 0) return [];
  const c = await stackCtx(f, r).catch(() => null);
  if (c === null) return [...guard.moved];
  const stuck: number[] = [];
  for (const d of guard.moved) {
    try {
      f.provider.retarget(c.project, d, guard.from);
    } catch (e) {
      if (!isGbError(e)) throw e;
      stuck.push(d);
      continue;
    }
    await describeNew(ctx, f, c.project.path, d);
  }
  return stuck;
}

/** `merge_failed`: the error to give for a merge that failed after `beforeMerge` moved dependents. A
 * network failure may have merged anyway: nothing is put back, and the message says so. */
export async function mergeFailed(f: DemoForge, r: Remotes, guard: MergeGuard, err: GbError, ctx: DemoContext): Promise<GbError> {
  if (guard.moved.length === 0) return err;
  if (err.kind === 'Network') return { ...err, message: `${err.message} (dependents were retargeted to ${guard.to} first)` };
  const stuck = await afterFailedMerge(f, r, guard, ctx);
  return stuck.length === 0 ? err : { ...err, message: appendStuck(err.message, stuck, guard.to) };
}
