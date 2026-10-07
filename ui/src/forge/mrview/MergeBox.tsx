import { Check, ChevronDown, Clock, LoaderCircle, X, type LucideIcon } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { useLend } from '../../app/lent';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import type { MergeMethod } from '../../api/gen/MergeMethod';
import type { MergeOptions } from '../../api/gen/MergeOptions';
import { ForgeAvatar } from '../../avatars/Avatar';
import { openMenuAt } from '../../menu/menuStore';
import type { MenuRow } from '../../menu/types';
import { confirmAction } from '../../ui/ConfirmDialog';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { Switch } from '../../ui/Switch';
import { useToast } from '../../ui/toast';
import { forgeName, mrRef } from '../labels';
import { useForge } from '../mrStore';
import { branchesText, pipelineText } from '../mrText';
import { useProjectSettings } from './projectSettings';
import { forgeWrite, putMr } from './writes';

export const METHOD_LABELS: Record<MergeMethod, string> = { merge: 'Merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge', semiLinear: 'Merge commit with semi-linear history', fastForward: 'Fast-forward merge' };
/** The primary button's tooltip: how it merges (the method is no line of its own). */
const METHOD_TIPS: Record<MergeMethod, string> = { merge: 'Merges with a merge commit', squash: 'Squashes the commits into one, then merges', rebase: 'Rebases the commits onto the target, then merges', semiLinear: 'Merges with a merge commit, keeping the history semi-linear', fastForward: 'Merges by fast-forwarding' };

/** A row kept in the layout but not shown (visibility, not display: its space stays). */
const reserved = (hidden: boolean) => (hidden ? { style: { visibility: 'hidden' as const }, 'aria-hidden': true } : {});

/** Why Merge is disabled (spec #4 §2: "disabled with the reason when blocked"); null: it isn't. */
export function mergeBlock(kind: ForgeKind, detail: ForgeMrDetail | null): string | null {
  if (!detail) return 'Loading…';
  const s = detail.mergeStatus;
  if (s.kind === 'checking') return `${forgeName(kind)} is still checking whether it can merge`;
  return s.kind === 'blocked' ? s.reason : null;
}

/** Blocks no wait for the checks lifts: auto-merge isn't offered (the forge would refuse it too). */
const HARD_BLOCK = /conflict|draft|closed|merged already|being merged|isn't open/i;


type Mode = 'merge' | 'auto' | 'cancel' | 'none';

/**
 * Merge (spec #4 §2, ruling 8), and auto-merge as GitLab's widget has it: while the checks run the
 * button sets it to merge once they pass; once set, who set it and Cancel auto-merge. GitLab merges
 * with the project's method; squash follows the project (hidden for Never, locked on for Always)
 * and the MR's own choice; delete-source-branch defaults to the MR's, else the project's. GitHub's
 * method is one of the repository's (the button's dropdown); its branch deletion is the
 * repository's setting. The commit messages are the forge's own (its templates). Each click
 * arms in place; a merge sends the head sha the view loaded, so a moved
 * head is refused (Review Focus 3). No optimistic UI: the store changes only with the answer.
 */
export function MergeBox({ tabId, kind, mr: listed, detail }: { tabId: string; kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null }) {
  const mr = detail?.mr ?? listed;
  const remote = useForge((s) => s.byTab[tabId]?.remote ?? null);
  const { settings, error: settingsError } = useProjectSettings(tabId, remote);
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [squash, setSquash] = useState<boolean | null>(null);
  const [del, setDel] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<Mode | null>(null);
  const chevron = useRef<HTMLButtonElement>(null);
  // Ctrl+Shift+M (`keyActions.ts`), while the primary button would take a click; set below.
  const keyMerge = useRef<() => void>(() => {});
  const live = mr.state === 'open' || mr.state === 'draft';
  const blockedRaw = mergeBlock(kind, detail) ?? (settings ? null : settingsError ? `Couldn't load merge options: ${settingsError}` : 'Loading merge options…');
  const pipe = mr.pipeline?.status ?? null;
  const checksRun = pipe === 'running' || pipe === 'pending';
  const auto = mr.autoMerge;
  // Auto-merge: offered while the checks run, unless something they can't lift blocks it.
  const offerAuto = live && !auto && checksRun;
  const autoBlock = !offerAuto ? null : !detail || detail.mergeStatus.kind === 'checking' || !settings ? blockedRaw ?? 'Loading…' : mr.state === 'draft' ? 'Mark it ready first: it\'s a draft' : blockedRaw && HARD_BLOCK.test(blockedRaw) ? blockedRaw : null;
  const mode: Mode = !live ? 'none' : auto ? 'cancel' : offerAuto ? 'auto' : 'merge';
  const blocked = mode === 'auto' ? autoBlock : mode === 'cancel' ? null : blockedRaw;
  const ready = mode !== 'none' && busy === null && blocked === null && (mode === 'cancel' || settings !== null);
  useLend('mr.merge', tabId, ready && mode !== 'cancel' ? () => keyMerge.current() : null);
  if (!live && mr.state !== 'merging') return null;

  const ref = mrRef(kind, mr.number);
  const methods = settings?.mergeMethods ?? [];
  const chosen = kind === 'gitlab' ? methods[0] ?? null : method ?? methods[0] ?? null;
  const squashOpt = settings?.squash ?? 'defaultOff';
  const squashOn = squashOpt === 'always' ? true : squashOpt === 'never' ? false : squash ?? detail?.squash ?? squashOpt === 'defaultOn';
  const delOn = del ?? detail?.deleteSourceBranch ?? settings?.deleteSourceBranch ?? false;

  const options = (): MergeOptions => {
    const expectedSha = mr.headSha;
    return kind === 'gitlab'
      ? { method: null, squash: squashOpt === 'never' ? null : squashOn, deleteSourceBranch: delOn, expectedSha }
      : { method: chosen, squash: null, deleteSourceBranch: null, expectedSha };
  };
  const doneToast = (out: ForgeMr) => {
    const t = useToast.getState();
    if (out.state === 'merged') t.show(`Merged ${ref} into ${mr.targetBranch}`);
    else if (out.state === 'merging') t.show(`Merging ${ref} into ${mr.targetBranch}…`);
    else t.show(`${ref} will merge when all checks pass`);
  };
  const run = async () => {
    if (mode === 'merge') {
      if (!(await confirmAction({ title: `Merge ${ref}?`, body: branchesText(mr), confirmLabel: 'Merge', arm: `Click again to merge ${ref} into ${mr.targetBranch}`, tone: 'positive' }))) return;
      const opts = options();
      setBusy('merge');
      const out = await forgeWrite(tabId, `Couldn't merge ${ref}`, (repo) => api.forgeMerge(repo, mr.number, opts));
      setBusy(null);
      if (!out) return;
      putMr(tabId, out.value);
      doneToast(out.value);
    } else if (mode === 'auto') {
      if (!(await confirmAction({ title: `Set ${ref} to auto-merge?`, body: 'It merges when all checks pass', confirmLabel: 'Set to auto-merge', arm: `Click again to set ${ref} to auto-merge`, tone: 'positive' }))) return;
      const opts = options();
      setBusy('auto');
      const out = await forgeWrite(tabId, `Couldn't set ${ref} to auto-merge`, (repo) => api.forgeSetAutoMerge(repo, mr.number, opts));
      setBusy(null);
      if (!out) return;
      putMr(tabId, out.value);
      doneToast(out.value);
    } else if (mode === 'cancel') {
      if (!(await confirmAction({ title: `Cancel auto-merge of ${ref}?`, confirmLabel: 'Cancel auto-merge', arm: `Click again to cancel auto-merge of ${ref}`, tone: 'warn' }))) return;
      setBusy('cancel');
      const out = await forgeWrite(tabId, `Couldn't cancel auto-merge of ${ref}`, (repo) => api.forgeCancelAutoMerge(repo, mr.number));
      setBusy(null);
      if (!out) return;
      putMr(tabId, out.value);
      useToast.getState().show(`Auto-merge of ${ref} cancelled`);
    }
  };
  keyMerge.current = () => void run();

  const failedText = kind === 'gitlab' ? 'The pipeline failed' : 'Some checks were not successful';
  const st = statusOf({ kind, mr, mode, blocked, detail, loaded: settings !== null || settingsError !== null, failedText });
  const Icon: LucideIcon = st.tone === 'ready' ? Check : st.tone === 'bad' ? X : mr.state === 'merging' ? LoaderCircle : Clock;
  const label = busy === 'merge' ? 'Merging…' : busy === 'auto' ? 'Setting…' : busy === 'cancel' ? 'Cancelling…' : mode === 'auto' ? 'Set to auto-merge' : mode === 'cancel' ? 'Cancel auto-merge' : 'Merge';
  const tip = mode === 'cancel' || mode === 'none' ? null : chosen ? `${METHOD_TIPS[chosen]}${mode === 'auto' ? ' once all checks pass' : ''}` : null;
  const disabled = !ready;
  const pick = !auto && kind === 'github' && methods.length > 1 && chosen !== null;
  const methodRows = (): MenuRow[] => methods.map((m) => ({
    kind: 'action', id: `merge.method.${m}`, label: METHOD_LABELS[m], icon: m === chosen ? Check : Blank, tooltip: METHOD_TIPS[m],
    run: () => setMethod(m),
  }));
  const go = (
    <button type="button" className={`mr-button mr-merge-go ${mode === 'cancel' ? 'cancel' : 'merge'}${pick ? ' split' : ''}`} disabled={disabled} onClick={() => void run()}>
      {label}
    </button>
  );
  return (
    <section className="mr-merge" aria-label="Merge">
      <div className="mr-merge-top">
        <span className={`mr-merge-dot ${st.tone}`} aria-hidden><Icon size={13} className={mr.state === 'merging' ? 'spin' : undefined} /></span>
        <div className="mr-merge-title">{st.title}</div>
        {/* Always in the layout: the reason, or what is ready, or an empty line. */}
        <span className={`mr-merge-reason ${st.tone}`} role="note">{st.note ?? ' '}</span>
        <div className="mr-merge-act" data-arm-grow="left">
          {tip && !disabled ? <HoverTooltip content={tip}>{go}</HoverTooltip> : go}
          {pick && (
            <button
              ref={chevron}
              type="button"
              className="mr-button mr-merge-pick merge"
              aria-label="Merge method"
              aria-haspopup="menu"
              disabled={busy !== null}
              onClick={() => { if (chevron.current) openMenuAt(chevron.current, methodRows(), `merge.method.${chosen}`, methodRows, 'Merge method'); }}
            >
              <ChevronDown size={14} aria-hidden />
            </button>
          )}
        </div>
      </div>
      {/* The rows are reserved while the options load (hidden, not removed), so nothing shifts. */}
      {live && !auto && (kind === 'gitlab' || settings?.deleteSourceBranch) && (
        <div className="mr-merge-opts">
          {kind === 'gitlab' && (
            <div className="switch-group mr-merge-switches">
              <div className="mr-merge-row" {...reserved(!settings)}>
                <Switch label="Delete source branch" description="After the merge" checked={delOn} disabled={!settings} onChange={setDel} />
              </div>
              <div className="mr-merge-row" {...reserved(!settings || squashOpt === 'never')}>
                <Switch label="Squash commits" description={squashOpt === 'always' ? 'This project always squashes' : `One commit on ${mr.targetBranch}`} checked={squashOn} disabled={!settings || squashOpt === 'always'} onChange={setSquash} />
              </div>
            </div>
          )}
          {kind === 'github' && settings?.deleteSourceBranch && <span className="mr-dim">GitHub deletes the branch after merging (repository setting)</span>}
        </div>
      )}
    </section>
  );
}

/** No icon: the unselected rows line up with the chosen row's check. */
const Blank = (() => null) as unknown as LucideIcon;

export type MergeTone = 'ready' | 'wait' | 'bad';

/** The merge box's icon colour, bold title and the line under it. */
function statusOf({ kind, mr, mode, blocked, detail, loaded, failedText }: { kind: ForgeKind; mr: ForgeMr; mode: Mode; blocked: string | null; detail: ForgeMrDetail | null; loaded: boolean; failedText: string }): { tone: MergeTone; title: ReactNode; note: string | null } {
  const failed = mr.pipeline?.status === 'failed';
  if (mr.state === 'merging') return { tone: 'wait', title: <b>Merging…</b>, note: `${forgeName(kind)} is merging it into ${mr.targetBranch}` };
  if (mode === 'cancel' && mr.autoMerge) {
    const by = mr.autoMerge.enabledBy;
    const title = (
      <>
        <b>Auto-merge set</b>
        {by && <> by <ForgeAvatar user={by} size={16} /> <b>{by.name}</b></>}
      </>
    );
    // The status line's second half under it ("· will merge…" wrapped to a line of its own otherwise).
    return failed ? { tone: 'bad', title, note: `${failedText}: it won't merge` } : { tone: 'wait', title, note: `Will merge when checks pass${mr.pipeline ? ` · ${pipelineText(kind, mr.pipeline)}` : ''}` };
  }
  if (mode === 'auto') {
    if (blocked !== null && detail && loaded && detail.mergeStatus.kind !== 'checking') return { tone: /conflict/i.test(blocked) ? 'bad' : 'wait', title: <b>Merge is blocked</b>, note: blocked };
    if (blocked !== null) return { tone: 'wait', title: <b>Checking…</b>, note: blocked };
    return { tone: 'wait', title: <b>{pipelineText(kind, mr.pipeline)}</b>, note: 'Merge when all checks pass' };
  }
  if (blocked === null) return { tone: 'ready', title: <b>Ready to merge</b>, note: readySummary(mr) };
  if (!detail || detail.mergeStatus.kind === 'checking' || (!loaded && detail.mergeStatus.kind === 'mergeable')) return { tone: 'wait', title: <b>Checking…</b>, note: blocked };
  if (failed) return { tone: 'bad', title: <b>Merge is blocked</b>, note: failedText };
  if (/schedul/i.test(blocked)) return { tone: 'wait', title: <b>Merge is scheduled</b>, note: blocked };
  if (/conflict|fail|couldn't|can't|cannot|merged already/i.test(blocked)) return { tone: 'bad', title: <b>Merge is blocked</b>, note: blocked };
  return { tone: 'wait', title: <b>Merge is blocked</b>, note: blocked };
}

/** "Pipeline passed · approved": what makes it ready, when the forge says. */
function readySummary(mr: ForgeMr): string | null {
  const bits: string[] = [];
  if (mr.pipeline?.status === 'success') bits.push('Pipeline passed');
  if (mr.review.decision === 'approved') bits.push('approved');
  return bits.length ? bits.join(' · ').replace(/^./, (c) => c.toUpperCase()) : null;
}
