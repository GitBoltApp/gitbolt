import { ArrowUpFromLine, Circle, CircleDot, ShieldAlert, ArrowUpRight } from 'lucide-react';
import { api } from '../api/client';
import { anchorNow } from '../branches/menus';
import { pickUpstream } from '../branches/upstream';
import { activeTab, registerActions } from '../app/actions';
import type { RepoCtx } from '../app/repoContext';
import { registerAppSlot } from '../app/slots';
import { useRuntime } from '../app/runtime';
import type { MenuRow } from '../menu/types';
import { useInFlight } from '../pending/store';
import { useQueuedKind } from '../queue/store';
import { registerToolbarButton } from '../toolbar/registry';
import { runWrite } from '../write/client';
import { writeCtx } from '../write/ctx';
import { isTypingOrEditor } from '../ui/keys';
import { offSyncMenu, registerSyncRows } from './menus';
import { branchOf, defaultRemote, forcePush, headBranchOf, nothingToPush, pushBranch, pushLabel, pushTooltip } from './push';
import { PushUpstreamPanel } from './PushUpstreamPanel';


/** The Push ▾ rows (spec #2 §12.3), built from the snapshot when the caret opens. */
function pushMenuRows({ tabId }: RepoCtx): MenuRow[] {
  const ctx = writeCtx(tabId);
  const b = branchOf(tabId, headBranchOf(tabId));
  if (!ctx || !b) return [];
  const remotes = useRuntime.getState().tabs[tabId]?.sidebar?.remotes ?? [];
  const same: MenuRow[] = remotes.flatMap((g) => g.branches.filter((r) => r.name === b.name).map((r): MenuRow => {
    const current = b.upstream === r.fullName;
    return {
      kind: 'action', id: `push.upstream.${g.name}`, label: `${g.name}/${r.name}`, icon: current ? CircleDot : Circle,
      tooltip: current ? `${b.name} tracks ${g.name}/${r.name}` : `Track ${g.name}/${r.name} (pushes nothing)`,
      run: () => { void runWrite(ctx, () => api.setUpstream(ctx.repoId, ctx.worktree, b.name, { remote: g.name, branch: r.name })); },
    };
  }));
  return [
    ...same,
    { kind: 'action', id: 'push.otherBranch', label: 'Other branch…', icon: ArrowUpRight, tooltip: `Choose the remote branch ${b.name} tracks`, run: () => pickUpstream(ctx, b.name, anchorNow()) },
    { kind: 'separator' },
    {
      kind: 'action', id: 'push.force', label: 'Force push (with lease)…', icon: ShieldAlert, tooltip: `Replace ${b.pushTarget ?? 'the remote branch'} with ${b.name}, only if nobody else pushed since your last fetch`,
      disabledReason: b.pushTarget ? undefined : `${b.name} has no push target`, run: () => { void forcePush(ctx, b); },
    },
  ];
}

const offs = [
  offSyncMenu,
  registerAppSlot('overlay', 'pushUpstream', PushUpstreamPanel),
  registerActions([{
    id: 'sync.push', label: 'Push', group: 'Repository', icon: ArrowUpFromLine, tooltip: 'Push the current branch', shortcuts: ['Ctrl+Shift+K'],
    // In an editor, Monaco's (and VS Code's) Delete line.
    yieldsTo: isTypingOrEditor,
    when: () => { const t = activeTab(); return t?.kind === 'repo' && !!writeCtx(t.id); },
    run: () => {
      const t = activeTab();
      const ctx = t ? writeCtx(t.id) : null;
      const b = t ? branchOf(t.id, headBranchOf(t.id)) : undefined;
      if (ctx && b) void pushBranch(ctx, b);
    },
  }]),
  registerToolbarButton({
    action: 'sync.push', label: 'Push', order: 11,
    useView: ({ tabId }) => {
      const head = useRuntime(() => headBranchOf(tabId));
      const b = useRuntime(() => branchOf(tabId, head));
      const pushing = useInFlight(tabId, 'push', b?.fullName ?? null);
      const v = pushTooltip(b, head, defaultRemote(tabId));
      return pushing && b ? { ...v, tooltip: `Pushing ${b.name}…` } : v;
    },
    useBusy: ({ tabId }) => {
      const head = useRuntime(() => headBranchOf(tabId));
      const b = useRuntime(() => branchOf(tabId, head));
      return useInFlight(tabId, 'push', b?.fullName ?? null);
    },
    useQueued: ({ repoId }) => useQueuedKind(repoId, 'push'),
    menuRows: pushMenuRows,
  }),
  registerSyncRows(10, (t, env) => {
    const local = t.branch?.local ? env.sidebar?.locals.find((b) => b.fullName === t.branch!.local) : undefined;
    const ctx = env.write;
    if (!local || !ctx || nothingToPush(local)) return [];
    const target = local.pushTarget;
    return [{
      kind: 'action', id: 'sync.push', label: 'Push', icon: ArrowUpFromLine,
      tooltip: pushLabel(local),
      run: () => { void pushBranch(ctx, local); },
      // Force needs a push target to replace: a branch with none only has the plain push.
      variants: target ? [{
        id: 'sync.push.force', label: 'force-with-lease', icon: ShieldAlert,
        tooltip: `Replace ${target} with ${local.name}, only if nobody else pushed since your last fetch`,
        run: () => { void forcePush(ctx, local); },
      }] : [],
    }];
  }),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
