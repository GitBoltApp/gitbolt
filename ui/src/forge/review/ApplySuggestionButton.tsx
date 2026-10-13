import { useEffect, useMemo, useReducer, useState } from 'react';
import type { DiffPosition } from '../../api/gen/DiffPosition';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useRuntime } from '../../app/runtime';
import { useTabView } from '../../app/tabStores';
import { useWorkingCopy } from '../../diff/workingCopy';
import type { SuggestionApplyProps } from '../../markdown/suggestion';
import type { RepoViewStore } from '../../repo/store';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { useToast } from '../../ui/toastStore';
import { useForge } from '../mrStore';
import { applyCheck, applyGate, applySuggestion, cantRead, wroteIt } from './applySuggestion';
import { readAtGen, rereadNow, watchWorkingFiles, workingGen } from './workingFiles';

const NO_STORE = createStore(() => ({ graph: null })) as unknown as RepoViewStore;

/** Where a published comment's suggestion applies: the tab's working copy, against this MR.
 * `position`: the thread's, which says whether it's on the MR's head. */
export interface SuggestionTarget { tabId: string; kind: ForgeKind; mr: ForgeMr; position?: DiffPosition | null }

/** The `MdSuggestionApply` render function for a published comment's Markdown. */
export const applyControl = (target: SuggestionTarget) => function render(p: SuggestionApplyProps) {
  return <ApplySuggestionButton target={target} {...p} />;
};

/**
 * A suggestion's Apply (spec 2026-10-08): enabled only with the MR's source branch checked out at
 * its head and the replaced lines unchanged in the working copy; otherwise disabled, its tooltip
 * saying why. The working-copy file is read again at each new generation of the worktree's files
 * (`workingFiles`), one read for all the buttons on it.
 */
export function ApplySuggestionButton({ target, path, from, replaced, suggested }: SuggestionApplyProps & { target: SuggestionTarget }) {
  const { tabId, kind, mr, position } = target;
  const headSha = useForge((s) => s.byTab[tabId]?.details[mr.number]?.value?.mr.headSha ?? null) ?? mr.headSha;
  // What the gate reads: the graph (branch, HEAD), the runtime (worktree, branches), the editor.
  const view = useTabView(tabId);
  const graph = useStore(view?.store ?? NO_STORE, (s) => s.graph);
  const rt = useRuntime((s) => s.tabs[tabId]);
  const copy = useWorkingCopy((s) => s.copies[tabId]);
  const gate = useMemo(() => applyGate(tabId, kind, mr, headSha, path, position), [tabId, kind, mr, headSha, path, position, graph, rt, copy]); // eslint-disable-line react-hooks/exhaustive-deps
  const ctx = 'ctx' in gate ? gate.ctx : null;
  // A new generation of the worktree's files (a WIP change settled, this apply): read it again.
  const [, renew] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!ctx || !view) return;
    const off = watchWorkingFiles(tabId, view.services.wip, ctx.worktree, renew);
    renew(); // watched: its generation's shared read
    return off;
  }, [tabId, view, ctx?.worktree]); // eslint-disable-line react-hooks/exhaustive-deps
  const gen = ctx ? workingGen(tabId, ctx.worktree) : 0;
  const [file, setFile] = useState<{ key: string; text: string | null; base: string | null } | null>(null);
  const key = ctx ? `${ctx.repoId}\u0000${ctx.worktree}\u0000${path}\u0000${gen}` : null;
  useEffect(() => {
    if (!ctx || key === null || gen === 0) return;
    let live = true;
    void readAtGen(tabId, ctx.repoId, ctx.worktree, path).then((f) => { if (live) setFile({ key, text: f?.text ?? null, base: f?.base ?? null }); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const checked = file?.key === key ? file : null;
  const reason = 'reason' in gate ? gate.reason : !checked || !ctx ? null
    : checked.text === null || checked.base === null ? cantRead(path)
    : applyCheck(checked.text, from, replaced, suggested, wroteIt(ctx.worktree, path, from, suggested, checked.base));
  const off = busy || reason !== null || !checked;
  const run = async () => {
    if (off || !ctx) return;
    // Checked again now: the branch or HEAD may have moved since this render.
    const now = applyGate(tabId, kind, mr, headSha, path, position);
    if ('reason' in now) return void useToast.getState().show(now.reason);
    setBusy(true);
    try {
      if (await applySuggestion(now, path, from, replaced, suggested)) rereadNow(tabId, now.ctx.worktree);
    } finally {
      setBusy(false);
    }
  };
  const tip = reason ?? (checked ? `Apply it to ${path} in the working copy` : 'Reading the working copy…');
  return (
    <HoverTooltip content={tip}>
      <button
        type="button"
        className="md-suggestion-apply"
        aria-disabled={off || undefined}
        aria-busy={busy || undefined}
        aria-label={reason ? `Apply the suggestion: ${reason}` : `Apply the suggestion to ${path}`}
        onClick={(e) => { e.stopPropagation(); void run(); }}
      >
        Apply
      </button>
    </HoverTooltip>
  );
}
