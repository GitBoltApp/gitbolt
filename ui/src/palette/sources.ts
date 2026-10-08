import { availableActions, invoke } from '../app/actions';
import { selectCommit } from '../app/graphNav';
import { openPathInTab, useRuntime } from '../app/runtime';
import { listTreeFiles, openFileView } from '../app/seams1b';
import { useAppState } from '../app/state';
import { activateTab, tabLabel } from '../app/tabs';
import { SETTINGS, useSettingsUi } from '../settings/schema';
import { checkoutLocal, checkoutRemote } from '../branches/checkout';
import { openFileHistory } from '../history/open';
import { useToast } from '../ui/toastStore';
import type { PaletteEntry } from './search';
import { displayChord } from '../ui/platformKeys';

export function actionEntries(): PaletteEntry[] {
  return availableActions()
    .filter((a) => a.id !== 'edit.palette')
    .map((a): PaletteEntry => ({ id: `action:${a.id}`, group: 'action', label: a.label, detail: a.shortcuts?.[0] && displayChord(a.shortcuts[0]), run: () => invoke(a) }));
}

export function refEntries(tabId: string): PaletteEntry[] {
  const s = useRuntime.getState().tabs[tabId]?.sidebar;
  if (!s) return [];
  const jump = (sha: string) => () => { if (!selectCommit(tabId, sha, { focus: true })) useToast.getState().show('Not in the loaded history'); };
  return [
    ...s.locals.map((b): PaletteEntry => ({ id: `ref:${b.fullName}`, group: 'ref', label: b.name, detail: 'local · Shift+Enter checks out', run: jump(b.target), alt: () => checkoutLocal(tabId, b.name) })),
    ...s.remotes.flatMap((g) => g.branches.map((b): PaletteEntry => ({ id: `ref:${b.fullName}`, group: 'ref', label: `${g.name}/${b.name}`, detail: 'remote · Shift+Enter checks out', run: jump(b.target), alt: () => checkoutRemote(tabId, g.name, b.name, b.target) }))),
    ...s.tags.map((t): PaletteEntry => ({ id: `ref:${t.fullName}`, group: 'ref', label: t.name, detail: 'tag', run: jump(t.target) })),
  ];
}

const fileCache = new Map<string, Promise<string[]>>();

/** Every file at HEAD (1B's tree listing, `services.treeFiles`), cached per repo and HEAD (spec §11.2). */
export async function fileEntries(tabId: string): Promise<PaletteEntry[]> {
  const rt = useRuntime.getState().tabs[tabId];
  const head = rt?.graph?.head.target;
  if (!rt?.repo || !head) return [];
  const key = `${rt.repo.id}:${head}`;
  if (!fileCache.has(key)) {
    // A moved HEAD makes the repo's older lists dead weight.
    for (const k of fileCache.keys()) if (k.startsWith(`${rt.repo.id}:`)) fileCache.delete(k);
  }
  if (!fileCache.has(key)) fileCache.set(key, listTreeFiles(tabId, head).catch(() => { fileCache.delete(key); return []; }));
  const paths = await fileCache.get(key)!;
  return paths.map((p): PaletteEntry => ({ id: `file:${p}`, group: 'file', label: p, detail: 'Shift+Enter: file history', run: () => void openFileView(tabId, head, p), alt: () => void openFileHistory(tabId, { path: p, rev: head }, false) }));
}

export function settingEntries(): PaletteEntry[] {
  return SETTINGS.map((s): PaletteEntry => ({ id: `setting:${s.id}`, group: 'setting', label: s.label, detail: s.section, run: () => useSettingsUi.getState().show(s.id) }));
}

export function tabEntries(): PaletteEntry[] {
  const { profile, updateProfile } = useAppState.getState();
  const runtimes = useRuntime.getState().tabs;
  const open = new Set(profile.tabs.map((t) => t.path));
  return [
    ...profile.tabs.map((t): PaletteEntry => ({ id: `tab:${t.id}`, group: 'tab', label: tabLabel(t, runtimes[t.id]?.repo?.name), detail: 'tab', run: () => updateProfile((p) => activateTab(p, t.id)) })),
    ...profile.recent.filter((r) => !open.has(r.path)).map((r): PaletteEntry => ({ id: `recent:${r.path}`, group: 'tab', label: r.name, detail: r.path, run: () => void openPathInTab(r.path) })),
  ];
}
