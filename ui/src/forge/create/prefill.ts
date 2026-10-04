import type { CreateContext } from '../../api/gen/CreateContext';
import type { CreateMr } from '../../api/gen/CreateMr';
import type { ForgeProjectSettings } from '../../api/gen/ForgeProjectSettings';
import type { LocalBranch } from '../../api/gen/LocalBranch';
import type { MrTemplate } from '../../api/gen/MrTemplate';
import type { RemoteBranch } from '../../api/gen/RemoteBranch';
import type { Stack } from '../../stacks/detect';
import type { MrDraft } from './draft';

/** Where the MR/PR goes from and to. */
export type Route = Pick<MrDraft, 'sourceRemote' | 'targetRemote' | 'targetBranch'>;

/** Ruling 6: the only template; with several, the one named Default; else none. */
export function defaultTemplate(templates: readonly MrTemplate[]): MrTemplate | null {
  if (templates.length === 1) return templates[0];
  return templates.find((t) => t.name.toLowerCase() === 'default') ?? null;
}

/** Ruling 5: the first commit's body, a blank line, then the template. */
export function joinDescription(body: string, template: MrTemplate | null): string {
  return [body.trim(), template?.body.trim() ?? ''].filter(Boolean).join('\n\n');
}

export interface Toggle { value: boolean; locked: boolean; caption: string | null }

/** GitLab's squash, from the project (spec #4 §2; ruling 10). */
export function squashToggle(s: ForgeProjectSettings): Toggle {
  switch (s.squash) {
    case 'always': return { value: true, locked: true, caption: 'This project always squashes' };
    case 'never': return { value: false, locked: true, caption: "This project doesn't allow squashing" };
    case 'defaultOn': return { value: true, locked: false, caption: null };
    default: return { value: false, locked: false, caption: null };
  }
}

/** Where a branch is pushed, from its push target (`origin/feature`): the remote whose name is
 * the longest matching prefix (a remote name may hold a `/`), and the branch's name there. */
export function pushedAs(b: LocalBranch | undefined, remotes: readonly string[]): { remote: string; branch: string } | null {
  const t = b?.pushTarget;
  if (!t) return null;
  const remote = [...remotes].sort((x, y) => y.length - x.length).find((n) => t.startsWith(`${n}/`));
  return remote ? { remote, branch: t.slice(remote.length + 1) } : null;
}

/** The branch's name on the source remote: its push target's there, unless that's the target
 * branch itself in the same project (a branch made from `origin/main` tracks it): then its own
 * name, so it's pushed as itself rather than blocked as targeting itself. */
export function sourceBranchOf(branch: string, pushed: { remote: string; branch: string } | null, a: { sourceRemote: string; targetBranch: string; sameProject: boolean }): string {
  if (!pushed || pushed.remote !== a.sourceRemote) return branch;
  return a.sameProject && pushed.branch === a.targetBranch ? branch : pushed.branch;
}

/** The local commits the source remote's branch doesn't have: 0 when they match (or there's none
 * there yet), the branch's `ahead` when that remote branch is its upstream, else `null` (they
 * differ by an unknown count). */
export function unpushedCount(local: LocalBranch | undefined, remote: RemoteBranch | undefined): number | null {
  if (!local || !remote || local.target === remote.target) return 0;
  return local.upstream === remote.fullName ? local.ahead : null;
}

/** Ruling 4: the branch below in a #3 stack (as it's pushed), else the project's default branch. */
export function defaultTarget(branch: string, stack: Stack | null, locals: readonly LocalBranch[], remotes: readonly string[], projectDefault: string | null): string {
  const i = stack ? stack.branches.indexOf(branch) : -1;
  if (stack && i > 0) {
    const below = stack.branches[i - 1];
    return pushedAs(locals.find((l) => l.name === below), remotes)?.branch ?? below;
  }
  return projectDefault ?? 'main';
}

/** A new draft: the first commit's subject and body, the default template, and the project's
 * squash and delete-source-branch defaults (GitLab only). */
export function freshDraft(ctx: CreateContext, route: Route): MrDraft {
  const tpl = defaultTemplate(ctx.templates);
  const description = joinDescription(ctx.firstCommit?.body ?? '', tpl);
  const gitlab = ctx.project.kind === 'gitlab';
  return {
    ...route, title: ctx.firstCommit?.summary ?? '', description, prefilled: description, template: tpl?.path ?? null,
    reviewers: [], assignees: [], labels: [], draft: false,
    squash: gitlab ? squashToggle(ctx.settings).value : null, deleteSourceBranch: gitlab ? ctx.settings.deleteSourceBranch : null,
  };
}

/** `tpl` (or none) in place of the current template. `edited`: the description isn't what the
 * prefill or a template wrote, so the caller confirms before replacing it. */
export function withTemplate(d: MrDraft, ctx: CreateContext, tpl: MrTemplate | null): { draft: MrDraft; edited: boolean } {
  const description = joinDescription(ctx.firstCommit?.body ?? '', tpl);
  return { draft: { ...d, description, prefilled: description, template: tpl?.path ?? null }, edited: d.description !== d.prefilled };
}

/** The forge-neutral request: ids for people, the trimmed title, GitLab's squash only while the
 * project leaves it open (ruling 10). */
export function createRequest(d: MrDraft, ctx: CreateContext, sourceBranch: string): CreateMr {
  const gitlab = ctx.project.kind === 'gitlab';
  return {
    source: { project: ctx.sourceProject, branch: sourceBranch }, targetBranch: d.targetBranch, title: d.title.trim(), description: d.description,
    draft: d.draft, reviewers: d.reviewers.map((u) => u.id), assignees: d.assignees.map((u) => u.id), labels: d.labels,
    squash: gitlab && !squashToggle(ctx.settings).locked ? d.squash : null, deleteSourceBranch: gitlab ? d.deleteSourceBranch : null,
  };
}

/** Why Create is disabled, or `null` (ruling 13). */
export function createBlocked(a: { draft: MrDraft; sourceBranch: string; onRemote: boolean; sourceProject: string; targetProject: string }): string | null {
  if (!a.onRemote) return `Push ${a.sourceBranch} to ${a.draft.sourceRemote} first`;
  if (a.sourceProject === a.targetProject && a.sourceBranch === a.draft.targetBranch) return `${a.sourceBranch} can't target itself`;
  if (!a.draft.title.trim()) return 'Enter a title';
  return null;
}
