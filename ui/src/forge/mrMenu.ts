import { FolderPlus, GitPullRequest, GitPullRequestDraft } from 'lucide-react';
import { ICONS } from '../menu/icons';
import type { MenuEnv, MrTarget } from '../menu/menuEnv';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { forgeName, mrLongNoun, mrRef } from './labels';
import { forgeOf } from './mrStore';
import { ownerOf } from './mrText';
import { checkoutMr, checkoutMrInWorktree, checkoutState, sourceRemote, unreadableSource, worktreeBlocked } from './mrview/checkout';
import { toggleMrDraft } from './mrview/writes';
import { openMrView } from './poll';

// A sidebar MR/PR row's menu (the `mr` kind). Built from memory like every menu (spec §7): the
// rows read the tab's stores; requests start only on a click.

type Action = Extract<MenuRow, { kind: 'action' }>;
const row = (r: Omit<Action, 'kind'>): MenuRow => ({ kind: 'action', ...r });

/** A project path as forges compare it (checkout.ts's `barePath`). */
const bare = (p: string) => p.trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
/** From a fork: its source project isn't the target's (and could be read). */
const fromFork = (t: MrTarget) => !unreadableSource(t.mr) && bare(t.mr.sourceProject) !== bare(t.mr.targetProject);

export const NOT_LOCAL = 'Not in this repository yet: fetch or check out first';

export const offMrMenus: Array<() => void> = [
  registerMenu<MrTarget, MenuEnv>({
    id: 'mr.open', kind: 'mr', group: 'open', order: 0,
    rows: (t) => [row({
      id: 'mr.open', label: `Open ${mrLongNoun(t.forge)}`, icon: ICONS.mr, tooltip: `Show ${mrRef(t.forge, t.mr.number)} in its view`,
      run: () => openMrView(t.tabId, t.mr.number),
    })],
  }),

  /** Check out (the MR view's button, its label and reason), and the same in a new worktree. */
  registerMenu<MrTarget, MenuEnv>({
    id: 'mr.checkout', kind: 'mr', group: 'checkout', order: 0,
    rows: (t, env) => {
      const { label, disabled } = checkoutState(t.tabId, t.mr);
      const blocked = worktreeBlocked(t.tabId, t.mr, env.worktreeShown);
      const fork = !unreadableSource(t.mr) && sourceRemote(t.tabId, t.mr) === null;
      return [
        row({
          id: 'mr.checkout', label, icon: ICONS.branch, tooltip: disabled ?? `Check out ${t.mr.sourceBranch}${fork ? ', adding the fork as a remote first' : ''}`,
          run: () => { void checkoutMr(t.tabId, t.mr); }, disabledReason: disabled ?? undefined,
        }),
        row({
          id: 'mr.checkoutWorktree', label: 'Check out in a new worktree…', icon: FolderPlus,
          tooltip: blocked ?? `Check out ${t.mr.sourceBranch} in a new directory${fork ? ', adding the fork as a remote first' : ''}`,
          run: () => { void checkoutMrInWorktree(t.tabId, t.mr); }, disabledReason: blocked ?? undefined,
        }),
      ];
    },
  }),

  registerMenu<MrTarget, MenuEnv>({
    id: 'mr.view', kind: 'mr', group: 'view', order: 0,
    rows: (t, env) => {
      const sha = t.mr.headSha;
      const why = !sha || !env.inGraph(sha) ? NOT_LOCAL : undefined;
      return [row({
        id: 'mr.showInGraph', label: 'Show in graph', icon: ICONS.graph, tooltip: why ?? `Select ${mrRef(t.forge, t.mr.number)}'s head commit in the graph`,
        run: () => { if (sha) env.act.showInGraph(sha); }, disabledReason: why,
      })];
    },
  }),

  /** `Copy link | Open |` (the remote's Forge link row's shape), the branch name, the number. */
  registerMenu<MrTarget, MenuEnv>({
    id: 'mr.copy', kind: 'mr', group: 'copy', order: 0,
    rows: (t, env) => {
      const { mr } = t;
      const ref = mrRef(t.forge, mr.number);
      const owned = `${ownerOf(mr.sourceProject)}:${mr.sourceBranch}`;
      return [
        row({
          id: 'mr.copyLink', label: 'Copy link', icon: ICONS.forge, tooltip: `Copy ${ref}'s web address`, run: () => env.act.copy(mr.webUrl),
          variants: [{ id: 'open', icon: ICONS.browser, tooltip: `Open ${ref} on ${forgeName(t.forge)} in the browser`, run: () => env.act.openUrl(mr.webUrl) }],
        }),
        row({
          id: 'mr.copyBranch', label: 'Copy branch name', icon: ICONS.branch, tooltip: `Copy "${mr.sourceBranch}"`, run: () => env.act.copy(mr.sourceBranch),
          variants: fromFork(t) ? [{ id: 'owner', label: 'owner:branch', tooltip: `Copy "${owned}"`, run: () => env.act.copy(owned) }] : undefined,
        }),
        row({ id: 'mr.copyNumber', label: 'Copy number', icon: ICONS.sha, tooltip: `Copy "${ref}"`, run: () => env.act.copy(ref) }),
      ];
    },
  }),

  /** Draft ⇄ ready: the author's own open MR/PR only (merge and approve stay in its view). */
  registerMenu<MrTarget, MenuEnv>({
    id: 'mr.draft', kind: 'mr', group: 'forge', order: 0,
    when: (t) => {
      const me = forgeOf(t.tabId).me;
      return me !== null && me === t.mr.author.username && (t.mr.state === 'open' || t.mr.state === 'draft');
    },
    rows: (t) => {
      const ref = mrRef(t.forge, t.mr.number);
      const draft = t.mr.state === 'draft';
      return [row({
        id: 'mr.draft', label: draft ? 'Mark as ready' : 'Convert to draft', icon: draft ? GitPullRequest : GitPullRequestDraft,
        tooltip: draft ? `Mark ${ref} as ready for review` : `Mark ${ref} as a draft`,
        run: () => { void toggleMrDraft(t.tabId, t.forge, t.mr); },
      })];
    },
  }),
];

import.meta.hot?.dispose(() => offMrMenus.forEach((off) => off()));
