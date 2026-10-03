import type { ReactNode } from 'react';
import { create } from 'zustand';
import type { RepoViewStore } from '../repo/store';

/**
 * An inline editor in a graph row's Branch/Tag cell, where the row's chips go (the
 * "enter branch name" input, UX round 1): a feature opens one (branches/inlineCreate.tsx) and renders
 * it; the graph only places it (ruling R10: the graph knows no feature). One at a time, app-wide:
 * opening another replaces it.
 */
export interface RowEditor {
  /** The row's commit id. */
  rowId: string;
  render: () => ReactNode;
}

interface RowEditorState { store: RepoViewStore | null; editor: RowEditor | null }

export const useRowEditors = create<RowEditorState>(() => ({ store: null, editor: null }));

export function openRowEditor(store: RepoViewStore, editor: RowEditor): void {
  useRowEditors.setState({ store, editor });
}

/** Closes `editor`, if it's still the open one (a newer one stays). */
export function closeRowEditor(editor: RowEditor): void {
  if (useRowEditors.getState().editor === editor) useRowEditors.setState({ store: null, editor: null });
}

/** The editor open in `store`'s graph, if any. */
export const useRowEditor = (store: RepoViewStore): RowEditor | null =>
  useRowEditors((s) => (s.store === store ? s.editor : null));
