import { createElement } from 'react';
import { api } from '../api/client';
import { useRuntime } from '../app/runtime';
import { tabStore } from '../app/tabStores';
import { useColumnPrefs } from '../graph/columns';
import { closeRowEditor, openRowEditor, type RowEditor } from '../graph/rowEditor';
import { promptText } from '../ui/PromptDialog';
import { runWrite, type WriteCtx } from '../write/client';
import { branchNameError } from './branchName';
import { BranchNameInput } from './BranchNameInput';

/** Where the branch starts: the commit, and the ref it was asked from (a remote-tracking one sets
 * the upstream, per `branch.autoSetupMerge`). */
export interface BranchStart { sha: string; ref: string | null }

/** A name a local branch already has, from the loaded sidebar. */
const taken = (tabId: string, name: string) => !!useRuntime.getState().tabs[tabId]?.sidebar?.locals.some((b) => b.name === name);

/** git's rules for a branch name, then "not already a branch": the inline input's and the
 * dialog's live check. */
export const branchCreateError = (tabId: string, v: string): string | null =>
  branchNameError(v) ?? (taken(tabId, v) ? `A branch named ${v} already exists` : null);

/** The write (§9.1): a CAS create, the upstream per autoSetupMerge, and a switch to it when
 * `checkout` (the default: the backend's create-and-checkout path, with its checks). */
export async function createBranch(ctx: WriteCtx, start: BranchStart, name: string, checkout = true): Promise<void> {
  await runWrite(ctx, (ok) => api.createBranch(ctx.repoId, ctx.worktree, { name, start: start.sha, startRef: start.ref, checkout, expect: { head: null, refs: { [`refs/heads/${name}`]: null } } }, ok));
}

/** The dialog: only where the graph can't show the inline input. Check out is on by default. */
async function createInDialog(ctx: WriteCtx, start: BranchStart): Promise<void> {
  const answer = await promptText({
    title: start.ref ? `Create a branch from ${start.ref.replace(/^refs\/(heads|remotes)\//, '')}` : `Create a branch at ${start.sha.slice(0, 7)}`,
    label: 'Branch name',
    confirmLabel: 'Create branch',
    validate: (v) => branchCreateError(ctx.tabId, v),
    checkbox: { label: 'Check out', initial: true },
  });
  if (answer) await createBranch(ctx, start, answer.value, answer.checked);
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * Create branch here and the toolbar Branch button (§9.1, UX round 1): an inline "enter
 * branch name" input in the commit's Branch/Tag cell. The row is selected first, which scrolls it
 * into view. Where there's no row to put it in (the commit isn't loaded, a file is open over the
 * graph, Branch/Tag is hidden, or the row didn't render), the dialog instead.
 */
export async function createBranchAt(ctx: WriteCtx, start: BranchStart): Promise<void> {
  const store = tabStore(ctx.tabId);
  const s = store?.getState();
  if (!store || !s || !s.indexById.has(start.sha) || s.diff !== null || useColumnPrefs.getState().hidden.has('labels')) return createInDialog(ctx, start);
  s.selectCommitById(start.sha);
  const editor: RowEditor = {
    rowId: start.sha,
    render: () => createElement(BranchNameInput, {
      validate: (v: string) => branchCreateError(ctx.tabId, v),
      onCancel: () => closeRowEditor(editor),
      onSubmit: (name: string, checkout: boolean) => {
        closeRowEditor(editor);
        void createBranch(ctx, start, name, checkout);
      },
    }),
  };
  openRowEditor(store, editor);
  // Rendered once the row is in the virtual window (the selection scrolled it there).
  await nextFrame();
  await nextFrame();
  if (!document.querySelector('.branch-inline-input')) {
    closeRowEditor(editor);
    await createInDialog(ctx, start);
  }
}
