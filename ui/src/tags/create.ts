import { createElement } from 'react';
import { api } from '../api/client';
import { tabStore } from '../app/tabStores';
import { shortSha } from '../format/sha';
import { useColumnPrefs } from '../graph/columns';
import { closeRowEditor, openRowEditor, type RowEditor } from '../graph/rowEditor';
import { promptText } from '../ui/PromptDialog';
import { useToast } from '../ui/toastStore';
import { runWrite, type WriteCtx } from '../write/client';
import { TagNameInput } from './TagNameInput';
import { tagCreateError } from './tagName';

/** The write (spec #3 §3.9): `message` null for a lightweight tag. Journaled: Undo removes it. */
export async function createTag(ctx: WriteCtx, sha: string, name: string, message: string | null): Promise<void> {
  await runWrite(ctx, () => api.createTag(ctx.repoId, ctx.worktree, { name, target: sha, message }), {
    onSuccess: () => useToast.getState().show(message === null ? `Created tag ${name}` : `Created annotated tag ${name}`),
  });
}

/** The dialog: only where the graph can't show the inline input. */
async function createInDialog(ctx: WriteCtx, sha: string, annotated: boolean): Promise<void> {
  const name = await promptText({ title: `Create a tag at ${shortSha(sha)}`, label: 'Tag name', confirmLabel: annotated ? 'Next' : 'Create tag', validate: (v) => tagCreateError(ctx.tabId, v) });
  if (!name) return;
  if (!annotated) return createTag(ctx, sha, name.value, null);
  const message = await promptText({ title: `Message for ${name.value}`, label: 'Tag message', confirmLabel: 'Create tag', validate: (v) => (v.trim() ? null : 'Enter a tag message') });
  if (message) await createTag(ctx, sha, name.value, message.value);
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Create tag here (spec #3 §3.9): the inline input in the commit's Branch/Tag cell, the row
 * selected first (it scrolls into view); the dialog where there's no row to put it in. */
export async function createTagAt(ctx: WriteCtx, sha: string, annotated: boolean): Promise<void> {
  const store = tabStore(ctx.tabId);
  const s = store?.getState();
  if (!store || !s || !s.indexById.has(sha) || s.diff !== null || useColumnPrefs.getState().hidden.has('labels')) return createInDialog(ctx, sha, annotated);
  s.selectCommitById(sha);
  const editor: RowEditor = {
    rowId: sha,
    render: () => createElement(TagNameInput, {
      annotated,
      validate: (v: string) => tagCreateError(ctx.tabId, v),
      onCancel: () => closeRowEditor(editor),
      onSubmit: (name: string, message: string | null) => {
        closeRowEditor(editor);
        void createTag(ctx, sha, name, message);
      },
    }),
  };
  openRowEditor(store, editor);
  await nextFrame();
  await nextFrame();
  if (!document.querySelector('.tag-inline-input')) {
    closeRowEditor(editor);
    await createInDialog(ctx, sha, annotated);
  }
}
