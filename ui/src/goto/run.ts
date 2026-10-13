import { api } from '../api/client';
import { readClipboardText } from '../api/transport';
import { selectCommit } from '../app/graphNav';
import { osKind } from '../app/osPath';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { activateTab, tabLabel, tabWorktree } from '../app/tabs';
import { tabStore, tabView, useTabViews } from '../app/tabStores';
import { isMarkdownPath } from '../diff/markdownFiles';
import { showSourceFor } from '../diff/markdownOverride';
import { toGbError } from '../errors/describe';
import { loadCommit } from '../find/findStore';
import { shortSha } from '../format/sha';
import { useFileListPrefs } from '../files/fileListPrefs';
import { revealInFileList } from '../files/reveal';
import { mrLongNoun, mrRef } from '../forge/labels';
import { forgeOf, knownMr, MR_FLYOUT } from '../forge/mrStore';
import { openMrView } from '../forge/poll';
import { openExternal } from '../markdown/actions';
import { recordPlace } from '../nav/history';
import { openFileAt } from '../nav/repoPlaces';
import { closeFlyout, flyoutOf } from '../ui/flyout/flyout';
import { useToast } from '../ui/toastStore';
import { setActiveWorktree } from '../worktrees/active';
import { classify } from './classify';
import { resolveGoto, type GotoAction, type GotoEnv, type GotoForge, type GotoTab } from './resolve';

const toast = (m: string, url: string | null = null) =>
  useToast.getState().show(m, url ? { action: { label: 'Open in browser', run: () => openExternal(url) } } : undefined);
/** How long a tab switched to may take to show its graph. */
const VIEW_WAIT_MS = 15_000;

const shortBranch = (ref: string | null) => ref?.replace(/^refs\/heads\//, '') ?? null;
const forgeOfProject = (p: { kind: GotoForge['kind']; path: string; webUrl: string } | null): GotoForge | null =>
  p ? { kind: p.kind, path: p.path, webUrl: p.webUrl.replace(/\/+$/, '') } : null;

/** The open tabs and stores, as the resolver reads them. */
export function liveEnv(): GotoEnv {
  return {
    tabs() {
      const { profile } = useAppState.getState();
      const rts = useRuntime.getState().tabs;
      const tabs = profile.tabs.flatMap((t): GotoTab[] => {
        if (t.kind !== 'repo' || !t.path) return [];
        const rt = rts[t.id];
        const worktree = rt?.worktree ?? tabWorktree(t) ?? t.path;
        const f = forgeOf(t.id);
        return [{
          tabId: t.id,
          active: t.id === profile.activeTab,
          loaded: !!rt?.graph,
          name: tabLabel(t, rt?.repo?.name),
          path: t.path,
          repo: rt?.repo?.id ?? null,
          worktree,
          worktrees: [...new Set([worktree, t.path, ...(rt?.graph?.worktrees.map((w) => w.path) ?? [])])],
          branch: shortBranch(rt?.graph?.worktrees.find((w) => w.path === worktree)?.branch ?? null),
          remotes: (rt?.info?.remotes ?? []).flatMap((r) => (r.host && r.path ? [{ host: r.host, path: r.path }] : [])),
          forge: f.kind && f.project ? forgeOfProject(f.project) : null,
        }];
      });
      return [...tabs.filter((t) => t.active), ...tabs.filter((t) => !t.active)];
    },
    async peek(tab) {
      const p = await api.peekRepo(tab.worktree);
      return { ...tab, branch: p.branch, remotes: p.remotes.flatMap((r) => (r.host && r.path ? [{ host: r.host, path: r.path }] : [])) };
    },
    async load(tab) {
      const repo = tab.repo ?? (await api.openRepo(tab.path)).id;
      const p = await api.forgeRepoProjects(repo);
      return {
        ...tab,
        repo,
        remotes: p.remotes.flatMap((r) => (r.host && r.path ? [{ host: r.host, path: r.path }] : [])),
        forge: forgeOfProject(p.remotes.find((r) => r.remote === p.target)?.project ?? null),
      };
    },
    open: (path) => api.openRepo(path).then((r) => r.id),
    locate: (repo, sha) => api.locateCommit(repo, sha).catch(() => null),
    refTip(tabId, name) {
      const sb = useRuntime.getState().tabs[tabId]?.sidebar;
      if (!sb) return null;
      const local = sb.locals.find((b) => b.name === name || b.fullName === name);
      if (local) return local.target;
      for (const g of sb.remotes) {
        const b = g.branches.find((x) => `${g.name}/${x.name}` === name || (x.name === name && name.startsWith(`${g.name}/`)) || x.fullName === name);
        if (b) return b.target;
      }
      return sb.tags.find((t) => t.name === name || t.fullName === name)?.target ?? null;
    },
    files: (repo, worktree) => api.worktreeFiles(repo, worktree),
    pathKind: (repo, worktree, path) => api.worktreePathKind(repo, worktree, path),
    caseless: osKind() !== 'linux',
  };
}

/** Resolves once tab `tabId` has its graph (false: it didn't come in time, or the tab closed). */
function whenView(tabId: string): Promise<boolean> {
  if (tabView(tabId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => { off(); clearTimeout(timer); resolve(ok); };
    const off = useTabViews.subscribe((s) => { if (s.views[tabId]) done(true); });
    const timer = setTimeout(() => done(false), VIEW_WAIT_MS);
  });
}

/** Makes `tabId` the active tab and waits for its graph; null if it's gone or never loads. */
async function showTab(tabId: string): Promise<string | null> {
  const app = useAppState.getState();
  if (!app.profile.tabs.some((t) => t.id === tabId)) return null;
  if (app.profile.activeTab !== tabId) app.updateProfile((p) => activateTab(p, tabId));
  return (await whenView(tabId)) ? tabId : null;
}

/** The tab showing `worktree` of `tabId`'s repository: another tab already on it, else `tabId`
 * switched to it. */
async function showWorktree(tabId: string, worktree: string): Promise<string | null> {
  const rt = useRuntime.getState().tabs[tabId];
  if (!rt?.repo || rt.worktree === worktree) return tabId;
  const twin = useAppState.getState().profile.tabs.find((t) => t.id !== tabId && t.kind === 'repo' && t.path === rt.repo!.path && tabWorktree(t) === worktree);
  if (twin) return showTab(twin.id);
  setActiveWorktree(tabId, worktree);
  return tabId;
}

const closeMrView = (tabId: string) => { if (flyoutOf(tabId)?.kind === MR_FLYOUT) closeFlyout(tabId); };

/** What the tab's file list shows a worktree's files under: its WIP row when it has changes,
 * else its HEAD commit (the same files). */
function filesOf(tabId: string, worktree: string): { commit: string | 'worktree'; row: string | null } {
  const s = tabStore(tabId)?.getState();
  if (s?.graph.rows.some((r) => r.wip?.worktreePath === worktree)) return { commit: 'worktree', row: `wip:${worktree}` };
  const head = useRuntime.getState().tabs[tabId]?.graph?.worktrees.find((w) => w.path === worktree)?.head ?? null;
  return head && s?.indexById.has(head) ? { commit: head, row: head } : { commit: 'worktree', row: null };
}

/** View all files on, for the list `commit`'s files show in. */
const allFilesFor = (commit: string) => useFileListPrefs.getState().set(commit === 'worktree' ? { wipAllFiles: true } : { allFiles: true });

/** Per tab, the watch that turns View all files back off once the file a paste opened closes. */
const allFilesWatch = new Map<string, () => void>();

/** A paste that turned View all files on (it was off) turns it off again when the file it opened
 * is closed, unless the user toggled it in between. */
function restoreAllFilesOnClose(tabId: string, commit: string) {
  const key = commit === 'worktree' ? 'wipAllFiles' : 'allFiles';
  const store = tabStore(tabId);
  if (!store || allFilesWatch.has(tabId)) return;
  const stop = () => { offDiff(); offPrefs(); allFilesWatch.delete(tabId); };
  const offDiff = store.subscribe((s, prev) => {
    if (!prev.diff || s.diff) return;
    useFileListPrefs.getState().set({ [key]: false });
    stop();
  });
  const offPrefs = useFileListPrefs.subscribe((p) => { if (!p[key]) stop(); });
  allFilesWatch.set(tabId, stop);
}

/** Does what `resolveGoto` decided. `live`: false once a newer paste took over. */
export async function runGoto(a: GotoAction, live: () => boolean = () => true): Promise<void> {
  switch (a.kind) {
    case 'none':
      return;
    case 'toast':
      toast(a.message, a.url);
      return;
    case 'commit': {
      const tabId = await showTab(a.tabId);
      if (!tabId || !live()) return;
      const there = await loadCommit(tabId, a.sha, a.limit);
      if (!live()) return;
      if (!there) {
        if (a.missing) toast(a.missing.message, a.missing.url);
        else toast(`${shortSha(a.sha)} isn't in the loaded history`);
        return;
      }
      closeMrView(tabId);
      recordPlace(tabId, { kind: 'commit', sha: a.sha });
      selectCommit(tabId, a.sha, { focus: true });
      return;
    }
    case 'mr': {
      const tabId = await showTab(a.tabId);
      if (!tabId || !live()) return;
      const f = forgeOf(tabId);
      // Opened only once the forge says it's an MR/PR (GitHub numbers issues alike): never the
      // browser on its own.
      if (!knownMr(f, a.number) && !f.details[a.number]) {
        const repo = tabView(tabId)?.repo;
        const ref = mrRef(a.forge, a.number);
        try {
          if (repo === undefined) return;
          await api.forgeMrDetail(repo, a.number);
        } catch (e) {
          if (!live()) return;
          const err = toGbError(e);
          toast(err.kind === 'NotFound' ? `${ref} isn't a ${mrLongNoun(a.forge)} in ${a.project}` : `Couldn't read ${ref}: ${err.message}`, a.url);
          return;
        }
        if (!live()) return;
      }
      openMrView(tabId, a.number);
      return;
    }
    case 'file': {
      // The resolver found the file: only now do the tab, its worktree and the list's view change.
      const shown = await showTab(a.tabId);
      const tabId = shown && live() ? await showWorktree(shown, a.worktree) : null;
      if (!tabId || !live()) return;
      const { commit } = filesOf(tabId, a.worktree);
      const wasAll = useFileListPrefs.getState()[commit === 'worktree' ? 'wipAllFiles' : 'allFiles'];
      allFilesFor(commit);
      // Lines are shown in the source: a Markdown file shows it rather than its rendered view.
      if (a.lines && isMarkdownPath(a.path)) showSourceFor(a.path);
      const opened = await openFileAt(tabId, a.path, commit, {
        record: true,
        closeMrView: true,
        line: a.lines ? { side: 'modified', line: a.lines.start, end: a.lines.end } : undefined,
      });
      if (!opened) return;
      if (!wasAll) restoreAllFilesOnClose(tabId, commit);
      revealInFileList(tabId, a.path, false);
      if (a.note) toast(a.note);
      return;
    }
    case 'folder': {
      const shown = await showTab(a.tabId);
      const tabId = shown && live() ? await showWorktree(shown, a.worktree) : null;
      if (!tabId || !live() || a.path === '') return;
      closeMrView(tabId);
      const { commit, row } = filesOf(tabId, a.worktree);
      const sel = tabStore(tabId)?.getState().selection;
      const showing = commit === 'worktree' ? sel?.kind === 'wip' && sel.worktree === a.worktree : sel?.kind === 'commit' && sel.id === commit;
      if (!showing && row) selectCommit(tabId, row);
      allFilesFor(commit);
      // The tree for now: the saved Path/Tree stays as it is.
      useFileListPrefs.getState().treeForSession();
      revealInFileList(tabId, a.path, true);
      return;
    }
  }
}

/** Bumped by every paste: an older one still resolving gives way. */
let pasteSeq = 0;

/** Goes to what `text` names (spec: paste anywhere to go to it). */
export async function gotoText(text: string, env: GotoEnv = liveEnv()): Promise<void> {
  const seq = ++pasteSeq;
  const live = () => seq === pasteSeq;
  const action = await resolveGoto(classify(text), env);
  if (live()) await runGoto(action, live);
}

/** "Go to what's on the clipboard" (Ctrl+V / Cmd+V outside a text field). */
export async function gotoClipboard(): Promise<void> {
  // No text on it (an image) or no reading it: nothing to go to, and nothing to say.
  const text = await readClipboardText().catch(() => null);
  if (typeof text === 'string') await gotoText(text);
}
