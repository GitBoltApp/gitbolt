import { Redo2, Undo2 } from 'lucide-react';
import { api } from '../api/client';
import type { HistoryRow } from '../api/gen/HistoryRow';
import type { JournalState } from '../api/gen/JournalState';
import type { JournalTop } from '../api/gen/JournalTop';
import type { MovedRef } from '../api/gen/MovedRef';
import { activeRuntime, activeTab, registerActions, type Action } from '../app/actions';
import type { RepoCtx } from '../app/repoContext';
import { compactRelativeTime } from '../format/relative';
import { notifyForgeAccountsChanged } from '../forge/accountsBus';
import type { MenuRow } from '../menu/types';
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
  afterRemotesChanged(out.label);
  const stays = top.kind === 'pull' ? ' (the fetched remote branches stay)' : '';
  useToast.getState().show(`Undid ${out.label}${note || stays}`, { action: { label: 'Redo', run: () => { void redo(ctx); } } });
}

/** A remote came back or went again (undo/redo of "remove remote …"): the forge's mapping and
 * main remote are read again at once, not at the next poll. */
function afterRemotesChanged(label: string): void {
  if (label.startsWith('remove remote ')) notifyForgeAccountsChanged();
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
    if (out?.status === 'done') {
      afterRemotesChanged(out.label);
      useToast.getState().show(`Redid ${out.label}`);
    }
  });
}

// --- UX Y: the Undo dropdown ---
/** What a row's tooltip says it touched: "a.txt, src/b.ts and 3 more". */
export function touchedText(touched: string[]): string {
  const shown = touched.slice(0, 3).join(', ');
  return touched.length > 3 ? `${shown} and ${touched.length - 3} more` : shown;
}

/** An older dropdown row: undone out of order, as an entry of its own, with no Redo. A question
 * it brings (the clean-restore warning) arms its row in place: started from the row, `runWrite`
 * holds the menu open for the answer (spec §ui confirms, Y.4). */
export async function undoFromHistory(ctx: WriteCtx, row: HistoryRow): Promise<void> {
  const origin = currentOrigin();
  await once(ctx, async () => {
    const out = await runWrite(ctx, (_, asked) => api.undoEntry(ctx.repoId, ctx.worktree, Number(row.entry), asked.autostash));
    if (!out) return;
    // Review 8: the list was stale and the entry was the newest, undone as Undo does: a branch
    // that moved since asks the same "Undo anyway" question, then Undo runs with what it showed.
    if (out.status === 'moved') {
      const body = movedText(out.label, out.refs);
      const ok = await confirmAction({ title: `Undo ${out.label}?`, body, confirmLabel: 'Undo anyway', arm: `Click again to undo ${out.label} anyway`, caption: body, danger: true }, origin);
      if (ok) await undoEntry(ctx, { entry: row.entry, label: row.label, kind: row.kind }, Object.fromEntries(out.refs.map((r) => [r.name, r.actual])), origin);
      return;
    }
    const text = `Undid ${out.label}${out.note ? ` (${out.note})` : ''}`;
    // The list was stale and the entry was the newest by then: the core undid it as Undo does,
    // onto the Redo stack, so the toast offers Redo as Undo's does.
    const redone = stateOf(ctx)?.redo?.entry === row.entry;
    useToast.getState().show(text, redone ? { action: { label: 'Redo', run: () => { void redo(ctx); } } } : undefined);
  });
}

/** The ▾ under Undo (Y.1): the newest undoable entries, newest first. The first is Undo itself;
 * an older one is listed disabled, with the reason, unless it's independent of every later one. */
export function historyRows(loaded: HistoryRow[] | undefined, s: JournalState | undefined, ctx: WriteCtx, now = Date.now()): MenuRow[] {
  // Not loaded (the read failed): Undo's own row, from the journal state.
  const top = s?.undo;
  const rows: HistoryRow[] = loaded?.length ? loaded : top ? [{ entry: top.entry, label: top.label, kind: top.kind, atMs: now, touched: [], blocked: s?.undoBlocked ?? null }] : [];
  if (!rows.length) {
    const why = s?.undoBlocked ?? 'Nothing to undo';
    return [{ kind: 'action', id: 'undo.history.none', label: 'Nothing to undo', icon: Undo2, tooltip: why, disabledReason: why, run: () => {} }];
  }
  return rows.map((r, i): MenuRow => {
    const when = compactRelativeTime(r.atMs / 1000, now / 1000);
    const touched = r.touched.length ? `; touched ${touchedText(r.touched)}` : '';
    return {
      kind: 'action',
      id: `undo.history.${r.entry}`,
      label: r.label,
      icon: Undo2,
      tooltip: `Undo ${r.label}${i === 0 ? '' : ' out of order'} (${when === 'now' ? 'just now' : `${when} ago`})${touched}`,
      shortcut: when,
      ...(r.blocked ? { disabledReason: r.blocked } : {}),
      run: () => { void (i === 0 ? undo(ctx) : undoFromHistory(ctx, r)); },
    };
  });
}

/** The dropdown's rows, read when it opens (review 3: the dependency check isn't part of every
 * journal state). Keyed as the journal store. */
const loadedHistory = new Map<string, HistoryRow[]>();
export async function loadHistory(repoId: number, worktree: string): Promise<void> {
  const key = journalKey(repoId, worktree);
  try {
    loadedHistory.set(key, await api.journalHistory(repoId, worktree));
  } catch (e) {
    console.warn('[gitbolt] undo history', e);
    loadedHistory.delete(key);
  }
}
export const historyOf = (repoId: number, worktree: string) => loadedHistory.get(journalKey(repoId, worktree));
// --- end UX Y ---

const view =(which: 'undo' | 'redo') => ({ repoId, worktree }: RepoCtx): ButtonView => {
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
  registerToolbarButton({
    action: 'edit.undo', label: 'Undo', order: 1, useView: view('undo'), useQueued: ({ repoId }) => useQueuedKind(repoId, 'undo'),
    // UX Y: the ▾ lists the recent entries, an older one undoable out of order.
    prepareMenu: ({ repoId, worktree }) => loadHistory(repoId, worktree),
    menuRows: ({ tabId, repoId, worktree }) => historyRows(historyOf(repoId, worktree), stateOf({ tabId, repoId, worktree }), { tabId, repoId, worktree }),
  }),
  registerToolbarButton({ action: 'edit.redo', label: 'Redo', order: 2, useView: view('redo'), useQueued: ({ repoId }) => useQueuedKind(repoId, 'redo') }),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
