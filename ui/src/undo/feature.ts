import { Redo2, Undo2 } from 'lucide-react';
import { api } from '../api/client';
import type { JournalState } from '../api/gen/JournalState';
import type { JournalTop } from '../api/gen/JournalTop';
import type { MovedRef } from '../api/gen/MovedRef';
import { activeRuntime, activeTab, registerActions, type Action } from '../app/actions';
import type { RepoCtx } from '../app/repoContext';
import { useQueuedKind } from '../queue/store';
import { registerToolbarButton, type ButtonView } from '../toolbar/registry';
import { currentOrigin, type Origin } from '../ui/arm/origin';
import { confirmAction } from '../ui/ConfirmDialog';
import { useToast } from '../ui/toast';
import { runWrite, type WriteCtx } from '../write/client';
import { journalKey, useJournal } from './store';

const shortRef = (name: string) => name.replace(/^refs\/(heads|remotes|tags)\//, '');
// HEAD's values are a branch (`refs/heads/x`) when it's on one, else a commit id.
const isRef = (v: string | null) => !!v && v.startsWith('refs/');
const short = (v: string | null) => (!v ? 'nothing' : isRef(v) ? shortRef(v) : v.slice(0, 7));

/** §5.4's prompt: "main moved since commit "Fix x" (it's at 1a2b3c, not 4d5e6f). Undoing moves
 * it to 7a8b9c and drops the 2 commits made since." A snapshot restore never moves HEAD
 * (`stays`): "HEAD moved since discard a.php (it's on feature, not main). Undoing leaves HEAD
 * there and restores the files over it." */
export function movedText(label: string, refs: MovedRef[]): string {
  return refs
    .map((r) => {
      const where = !r.actual ? 'it\'s gone' : `it's ${isRef(r.actual) ? 'on' : 'at'} ${short(r.actual)}`;
      const to = r.stays ? `leaves ${shortRef(r.name)} there and restores the files over it` : r.target ? `moves it to ${short(r.target)}` : 'deletes it';
      const drops = r.dropped ? ` and drops the ${r.dropped} ${r.dropped === 1 ? 'commit' : 'commits'} made since` : '';
      return `${shortRef(r.name)} moved since ${label} (${where}, not ${short(r.expected)}). Undoing ${to}${drops}.`;
    })
    .join(' ');
}

/** Ctrl+Z belongs to whatever has its own undo (spec #2 §5.5, §7.6): a text input, a textarea,
 * an editable Monaco (any Monaco is in the diff or File view), the diff view, the WIP file list. */
export function ownsUndo(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  // 2D T20: the merge tool's panel too (its own undo is the output's).
  if (el.closest('input, textarea, [contenteditable="true"], [contenteditable=""], .monaco-editor, .diff-panel, .merge-panel')) return true;
  const list = el.closest('.file-list');
  return !!list && !!list.closest('.details-panel')?.querySelector('[data-testid="wip-header"]');
}

// Keyed to the tab's active worktree: each worktree's journal is its own (T14 review M1, 2A
// final M11; spec #2 §11.2).
const target = (): WriteCtx | null => {
  const t = activeTab();
  const rt = activeRuntime();
  return t?.kind === 'repo' && rt?.repo ? { tabId: t.id, repoId: rt.repo.id, worktree: rt.worktree ?? rt.repo.path } : null;
};
const stateOf = (ctx: WriteCtx | null): JournalState | undefined => (ctx ? useJournal.getState().states[journalKey(ctx.repoId, ctx.worktree)] : undefined);

/** Undoes `top` (the entry the toolbar showed); `confirm`: "Undo anyway" with the refs as shown. */
async function undoEntry(ctx: WriteCtx, top: JournalTop, confirm?: Record<string, string | null>, origin: Origin | null = currentOrigin()): Promise<void> {
  // --- 2C T7: withoutIndex (a stash's undo/redo) ---
  const out = await runWrite(ctx, (_, asked) => api.undo(ctx.repoId, ctx.worktree, Number(top.entry), confirm, asked.autostash, asked.withoutIndex, asked.discard), { origin });
  // --- end 2C T7 ---
  if (!out) return;
  if (out.status === 'moved') {
    const body = movedText(out.label, out.refs);
    const ok = await confirmAction({ title: `Undo ${out.label}?`, body, confirmLabel: 'Undo anyway', arm: `Click again to undo ${out.label} anyway`, caption: body, danger: true }, origin);
    if (ok) await undoEntry(ctx, top, Object.fromEntries(out.refs.map((r) => [r.name, r.actual])), origin);
    return;
  }
  // --- 2C T10: the entry's own note (spec #2 §9.2) ---
  const note = out.note ? ` (${out.note})` : '';
  // --- end 2C T10 ---
  const stays = top.kind === 'pull' ? ' (the fetched remote branches stay)' : '';
  useToast.getState().show(`Undid ${out.label}${note || stays}`, { action: { label: 'Redo', run: () => { void redo(ctx); } } });
}

/** Worktrees with an undo or redo sent and not answered: a second press (a held Ctrl+Z, a
 * double click while it waits in the queue) would name the same entry again, so it's ignored. */
const inFlight = new Set<string>();
async function once(ctx: WriteCtx, run: () => Promise<void>): Promise<void> {
  const key = journalKey(ctx.repoId, ctx.worktree);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    await run();
  } finally {
    inFlight.delete(key);
  }
}

/** Toolbar Undo, Ctrl+Z and the palette's "Undo …" (spec #2 §5.5). */
export async function undo(ctx: WriteCtx, confirm?: Record<string, string | null>): Promise<void> {
  const s = stateOf(ctx);
  const top = s?.undo;
  if (!top || s.undoBlocked) return;
  await once(ctx, () => undoEntry(ctx, top, confirm));
}

export async function redo(ctx: WriteCtx): Promise<void> {
  const s = stateOf(ctx);
  const top = s?.redo;
  if (!top || s.redoBlocked) return;
  await once(ctx, async () => {
    // --- 2C T7: withoutIndex (a stash's undo/redo) ---
    const out = await runWrite(ctx, (_, asked) => api.redo(ctx.repoId, ctx.worktree, Number(top.entry), asked.autostash, asked.withoutIndex));
    // --- end 2C T7 ---
    if (out?.status === 'done') useToast.getState().show(`Redid ${out.label}`);
  });
}

const view = (which: 'undo' | 'redo') => ({ repoId, worktree }: RepoCtx): ButtonView => {
  const s = useJournal((st) => st.states[journalKey(repoId, worktree)]);
  const top = which === 'undo' ? s?.undo : s?.redo;
  const blocked = which === 'undo' ? s?.undoBlocked : s?.redoBlocked;
  const key = which === 'undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z';
  const reason = blocked ?? (top ? null : which === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
  return { tooltip: reason ?? `${which === 'undo' ? 'Undo' : 'Redo'} ${top!.label} (${key})`, disabled: !!reason };
};

const usable = (which: 'undo' | 'redo') => () => {
  const s = stateOf(target());
  return which === 'undo' ? !!s?.undo && !s.undoBlocked : !!s?.redo && !s.redoBlocked;
};

// The getters keep the palette's and the hamburger's rows current ("Undo commit "Fix x"").
const actions: Action[] = [
  {
    id: 'edit.undo', group: 'Edit', icon: Undo2, shortcuts: ['Ctrl+Z'], yieldsTo: ownsUndo, when: usable('undo'),
    get label() { const t = stateOf(target())?.undo; return t ? `Undo ${t.label}` : 'Undo'; },
    get tooltip() { const s = stateOf(target()); return s?.undoBlocked ?? (s?.undo ? `Undo ${s.undo.label}` : 'Nothing to undo'); },
    run: () => { const ctx = target(); return ctx ? undo(ctx) : undefined; },
  },
  {
    id: 'edit.redo', group: 'Edit', icon: Redo2, shortcuts: ['Ctrl+Shift+Z'], yieldsTo: ownsUndo, when: usable('redo'),
    get label() { const t = stateOf(target())?.redo; return t ? `Redo ${t.label}` : 'Redo'; },
    get tooltip() { const s = stateOf(target()); return s?.redoBlocked ?? (s?.redo ? `Redo ${s.redo.label}` : 'Nothing to redo'); },
    run: () => { const ctx = target(); return ctx ? redo(ctx) : undefined; },
  },
];

const offs = [
  registerActions(actions),
  // Spec #2 §14: repo · branch picker · Undo · Redo · Fetch/Pull · …
  registerToolbarButton({ action: 'edit.undo', label: 'Undo', order: 1, useView: view('undo'), useQueued: ({ repoId }) => useQueuedKind(repoId, 'undo') }),
  registerToolbarButton({ action: 'edit.redo', label: 'Redo', order: 2, useView: view('redo'), useQueued: ({ repoId }) => useQueuedKind(repoId, 'redo') }),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
