import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../../api/client';
import type { CreateContext } from '../../api/gen/CreateContext';
import type { ForgeLabel } from '../../api/gen/ForgeLabel';
import type { ForgeUser } from '../../api/gen/ForgeUser';
import { copyText } from '../../api/transport';
import { useRuntime } from '../../app/runtime';
import { stackBase, stackFor, stacksOf } from '../../stacks/detect';
import { registerKeyHints } from '../../shortcuts/hints';
import { openPushUpstream, pushBranch } from '../../sync/push';
import { confirmAction } from '../../ui/ConfirmDialog';
import { FlyoutFrame } from '../../ui/flyout/FlyoutFrame';
import { flyoutOf, type FlyoutProps } from '../../ui/flyout/flyout';
import { RefPicker } from '../../ui/RefPicker';
import { Select } from '../../ui/Select';
import { useToast } from '../../ui/toast';
import { writeCtx } from '../../write/ctx';
import { forgeName, mrLongNoun } from '../labels';
import { forgeOf } from '../mrStore';
import { mappedRemotes } from '../projects';
import { notifyForgeWrite } from '../usePolling';
import { discardMrDraft, flushMrDrafts, mrDraftKey, readMrDraft, useMrDrafts, writeMrDraft, type MrDraft } from './draft';
import { newMrUrl } from './newMrUrl';
import { showCreated } from './outcome';
import { createBlocked, createRequest, defaultTarget, freshDraft, pushedAs, sourceBranchOf, squashToggle, unpushedCount, withTemplate, type Route } from './prefill';
import { SearchPicker, type PickOption } from './SearchPicker';
import type { CreateMrArgs } from './store';
import './createMr.css';

const NO_FORGE = "No forge account for this repository's remotes: add one in Settings › Accounts";

const userOption = (u: ForgeUser): PickOption<ForgeUser> => ({ key: String(u.id), label: u.name, detail: `@${u.username}`, value: u });
const labelOption = (l: ForgeLabel): PickOption<ForgeLabel> => ({ key: l.name, label: l.name, color: l.color, value: l });

/** The Create flyout (4B's host mounts it fresh for each open, with the branch as its props). */
export function CreateMrFlyout({ tabId, props: { branch }, close: closeFrame }: FlyoutProps<CreateMrArgs>) {
  const repoId = useRuntime((s) => s.tabs[tabId]?.repo?.id);
  const repoPath = useRuntime((s) => s.tabs[tabId]?.repo?.path);
  const sidebar = useRuntime((s) => s.tabs[tabId]?.sidebar ?? null);
  const saved = useMrDrafts((s) => (repoPath ? s.drafts[mrDraftKey(repoPath, branch)] : undefined));
  const [title, setTitle] = useState('Create MR/PR');
  const [problem, setProblem] = useState<string | null>(null);
  const [choices, setChoices] = useState<string[]>([]);
  const [route, setRoute] = useState<Route | null>(null);
  const [ctx, setCtx] = useState<CreateContext | null>(null);
  const [draft, setDraft] = useState<MrDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<DOMRect | null>(null);
  const [colors, setColors] = useState<Record<string, string | null>>({});
  const [loaded, setLoaded] = useState<Route | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const goodRoute = useRef<Route | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const close = () => { flushMrDrafts(); closeFrame(); };
  const discardSaved = async () => {
    if (!repoPath) return;
    const ok = await confirmAction({ title: 'Discard this draft?', body: `The title, description and choices for ${branch} are deleted.`, confirmLabel: 'Discard draft', arm: 'Click again to discard the draft', danger: true });
    if (!ok) return;
    discardMrDraft(repoPath, branch);
    closeFrame();
  };

  // Where it goes: a saved draft's route, else the branch's push remote → the repo's target
  // project, onto the branch below in a stack or the project's default branch (rulings 3, 4).
  useEffect(() => {
    let live = true;
    const rt = useRuntime.getState().tabs[tabId];
    const f = forgeOf(tabId);
    if (!f.remote || !f.project || !rt?.repo) { setProblem(NO_FORGE); return; }
    const target = { remote: f.remote, project: f.project };
    const repo = rt.repo;
    const begin = (mapped: string[]) => {
      if (!live) return;
      setTitle(`Create ${mrLongNoun(target.project.kind)}`);
      const groups = rt.sidebar?.remotes ?? [];
      const names = groups.map((g) => g.name);
      const locals = rt.sidebar?.locals ?? [];
      const pushed = pushedAs(locals.find((b) => b.name === branch), names);
      // Only remotes on the target's forge: a push remote elsewhere can't be the source.
      setChoices(mapped);
      const keep = readMrDraft(repo.path, branch);
      if (keep) { setRoute({ sourceRemote: keep.sourceRemote, targetRemote: keep.targetRemote, targetBranch: keep.targetBranch }); return; }
      const stack = rt.graph ? stackFor(stacksOf(rt.graph, stackBase(rt.graph, groups)), branch) : null;
      setRoute({ sourceRemote: pushed && mapped.includes(pushed.remote) ? pushed.remote : target.remote, targetRemote: target.remote, targetBranch: defaultTarget(branch, stack, locals, names, target.project.defaultBranch) });
    };
    // The remotes with a project on the target's host (4A's request, cached in core).
    void api.forgeRepoProjects(repo.id, false).then((p) => mappedRemotes(p, target.project.host), () => [target.remote]).then(begin).catch((e) => { if (live) setProblem(errorMessage(e)); });
    return () => { live = false; };
  // Deliberately keyed on the tab and branch only: the route is chosen once per open.
  }, [tabId, branch]);

  // The context for this route: an untouched draft is prefilled again; a saved one keeps its text.
  useEffect(() => {
    if (!route || repoId === undefined || !repoPath) return;
    let live = true;
    api.forgeCreateContext(repoId, route.targetRemote, route.sourceRemote, branch, route.targetBranch).then((c) => {
      if (!live) return;
      const keep = readMrDraft(repoPath, branch);
      const next = keep ? { ...keep, ...route } : freshDraft(c, route);
      setCtx(c);
      setDraft(next.template && !c.templates.some((t) => t.path === next.template) ? { ...next, template: null } : next);
      goodRoute.current = route;
      setLoaded(route);
    }, (e) => {
      if (!live) return;
      const good = goodRoute.current;
      if (!good) { setProblem(errorMessage(e)); return; }
      // A failed route change goes back to the route that worked, in state and in the saved draft.
      const kept = readMrDraft(repoPath, branch);
      if (kept) writeMrDraft(repoPath, branch, { ...kept, ...good });
      setDraft((d) => (d ? { ...d, ...good } : d));
      setRouteError(`Couldn't load ${route.targetRemote}/${route.targetBranch}: ${errorMessage(e)}`);
      setRoute(good);
    });
    return () => { live = false; };
    // Keyed on the route and the repo only; draft reads are one-shot.
  }, [route, repoId, repoPath, branch]);

  if (problem) {
    return (
      <FlyoutFrame label={title} title={title} onClose={close}>
        <p className="create-mr-problem" role="alert">{problem}</p>
        {saved && <div className="modal-actions create-mr-actions"><button type="button" onClick={() => { void discardSaved(); }}>Discard draft</button></div>}
      </FlyoutFrame>
    );
  }
  if (!ctx || !draft || !route || repoId === undefined || !repoPath) return <FlyoutFrame label={title} title={title} onClose={close}><p className="create-mr-loading">Loading…</p></FlyoutFrame>;

  const kind = ctx.project.kind;
  const noun = mrLongNoun(kind);
  const loading = loaded !== route;
  const update = (next: MrDraft) => { setDraft(next); setError(null); writeMrDraft(repoPath, branch, next); };
  const move = (patch: Partial<Route>) => {
    const next = { ...route, ...patch };
    setRouteError(null);
    if (saved) update({ ...draft, ...next });
    else setDraft({ ...draft, ...next });
    setRoute(next);
  };
  const names = (sidebar?.remotes ?? []).map((g) => g.name);
  const local = sidebar?.locals.find((b) => b.name === branch);
  const pushed = pushedAs(local, names);
  const sourceBranch = sourceBranchOf(branch, pushed, { sourceRemote: draft.sourceRemote, targetBranch: draft.targetBranch, sameProject: ctx.sourceProject === ctx.project.path });
  const onSource = sidebar?.remotes.find((g) => g.name === draft.sourceRemote)?.branches.find((b) => b.name === sourceBranch);
  const onRemote = !!onSource;
  const unpushed = unpushedCount(local, onSource);
  // Pushed elsewhere than the source (another remote, or the target branch itself): ask where.
  const pushElsewhere = !!pushed && (pushed.remote !== draft.sourceRemote || pushed.branch !== sourceBranch);
  const pushNote = createBlocked({ draft, sourceBranch, onRemote, sourceProject: ctx.sourceProject, targetProject: ctx.project.path });
  const blocked = loading ? 'Loading…' : pushNote;
  const squash = squashToggle(ctx.settings);
  const targets = (sidebar?.remotes.find((g) => g.name === draft.targetRemote)?.branches ?? []).map((b) => b.name).filter((n) => n !== 'HEAD');
  const remoteOptions = choices.map((r) => [r, r] as const);
  const templateOptions: ReadonlyArray<readonly [string, string]> = [['', 'No template'], ...ctx.templates.map((t) => [t.path, t.name] as const)];

  const submit = async () => {
    if (blocked || busy) return;
    const req = createRequest(draft, ctx, sourceBranch);
    // The create outlives this mount (Esc or × during "Creating…"): it closes only the flyout it
    // was started from, and a failure after an unmount goes to a toast.
    const mine = flyoutOf(tabId)?.seq;
    const sent = draft;
    // The fieldset disables what has the focus: it goes back there once the form is editable again.
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusy(true);
    setError(null);
    try {
      const out = await api.forgeCreateMr(repoId, draft.targetRemote, req);
      discardMrDraft(repoPath, branch);
      if (flyoutOf(tabId)?.seq === mine) closeFrame();
      showCreated({ repoId, remote: draft.targetRemote, kind, req, number: out.mr.number, webUrl: out.mr.webUrl }, out.failed);
      notifyForgeWrite(tabId);
    } catch (e) {
      setError(errorMessage(e));
      if (!mounted.current) {
        writeMrDraft(repoPath, branch, sent);
        flushMrDrafts();
        useToast.getState().show(`Couldn't create ${noun} from ${branch}: ${errorMessage(e)}; the draft is kept`, { tone: 'warning' });
      }
    } finally {
      setBusy(false);
      setTimeout(() => { if (mounted.current && focused?.isConnected) focused.focus({ preventScroll: true }); });
    }
  };
  const continueOnForge = () => {
    const { url, withoutDescription, withoutMore } = newMrUrl(ctx.project, { project: ctx.sourceProject, branch: sourceBranch }, draft);
    void api.openUrl(url);
    if (withoutDescription) {
      void copyText(draft.description);
      useToast.getState().show(`The description is too long for the link: it's on the clipboard to paste on ${forgeName(kind)}${withoutMore ? '; the labels or title were trimmed too' : ''}`);
    }
  };
  const discard = discardSaved;
  const chooseTemplate = async (path: string) => {
    const next = withTemplate(draft, ctx, ctx.templates.find((t) => t.path === path) ?? null);
    if (next.edited && !(await confirmAction({ title: 'Replace the description?', body: 'Your edits to the description are replaced by the template.', confirmLabel: 'Replace', arm: 'Click again to replace your description', danger: true }))) return;
    update(next.draft);
  };
  // Keys typed in the fields never reach the app's shortcuts; Ctrl+Enter creates.
  const fieldKeys = (e: KeyboardEvent<HTMLElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
  };

  return (
    <FlyoutFrame label={title} title={title} onClose={close}>
      {/* Only Ctrl+Enter and the Create button create (an irreversible forge write): Enter never submits. */}
      <form onSubmit={(e) => e.preventDefault()}>
        {/* Read-only while "Creating…": what's sent is what's shown. */}
        <fieldset className="create-mr" disabled={busy}>
          <div className="create-mr-route">
            <span className="create-mr-label">From</span>
            <Select aria-label="Source remote" value={draft.sourceRemote} options={remoteOptions} onChange={(v) => move({ sourceRemote: v })} />
            <code className="create-mr-branch">{sourceBranch}</code>
            <span className="create-mr-label">To</span>
            <Select aria-label="Target remote" value={draft.targetRemote} options={remoteOptions} onChange={(v) => move({ targetRemote: v })} />
            <button type="button" className="create-mr-target" aria-label="Target branch" onClick={(e) => setPicking(e.currentTarget.getBoundingClientRect())}>{draft.targetBranch}</button>
          </div>
          {!onRemote && (
            <p className="create-mr-note" role="status">
              <span>{pushNote}</span>
              {local && <button type="button" onClick={() => { const w = writeCtx(tabId); if (w) void (pushElsewhere ? openPushUpstream : pushBranch)(w, local); }}>Push {branch}{pushElsewhere ? '…' : ''}</button>}
            </p>
          )}
          {unpushed !== 0 && (
            <p className="create-mr-note" role="status">
              {unpushed === null ? `${branch} differs from ${draft.sourceRemote}/${sourceBranch}` : `${unpushed === 1 ? "1 commit isn't" : `${unpushed} commits aren't`} pushed yet`}: the {noun} shows what {draft.sourceRemote} has
            </p>
          )}
          <label className="create-mr-field">
            <span>Title</span>
            <input aria-label="Title" value={draft.title} spellCheck={false} autoComplete="off" autoFocus onChange={(e) => update({ ...draft, title: e.target.value })} onKeyDown={fieldKeys} onBlur={flushMrDrafts} />
          </label>
          <div className="create-mr-template">
            <span className="create-mr-label">Template</span>
            <Select aria-label="Template" value={draft.template ?? ''} options={templateOptions} onChange={(v) => { void chooseTemplate(v); }} />
            {ctx.templatesLocal && <span className="create-mr-hint">From the local copy of {draft.targetBranch}</span>}
          </div>
          <label className="create-mr-field">
            <span>Description</span>
            <textarea aria-label="Description" rows={10} value={draft.description} spellCheck={false} onChange={(e) => update({ ...draft, description: e.target.value })} onKeyDown={fieldKeys} onBlur={flushMrDrafts} />
          </label>
          <SearchPicker
            label="Reviewers"
            chips={draft.reviewers.map((u) => ({ key: String(u.id), label: u.name }))}
            onRemove={(k) => update({ ...draft, reviewers: draft.reviewers.filter((u) => String(u.id) !== k) })}
            search={(q) => api.forgeSearchUsers(repoId, draft.targetRemote, q).then((l) => l.map(userOption))}
            onPick={(u) => update({ ...draft, reviewers: [...draft.reviewers, u] })}
          />
          <SearchPicker
            label="Assignees"
            chips={draft.assignees.map((u) => ({ key: String(u.id), label: u.name }))}
            onRemove={(k) => update({ ...draft, assignees: draft.assignees.filter((u) => String(u.id) !== k) })}
            search={(q) => api.forgeSearchUsers(repoId, draft.targetRemote, q).then((l) => l.map(userOption))}
            onPick={(u) => update({ ...draft, assignees: [...draft.assignees, u] })}
          />
          <SearchPicker
            label="Labels"
            chips={draft.labels.map((l) => ({ key: l, label: l, color: colors[l] ?? null }))}
            onRemove={(k) => update({ ...draft, labels: draft.labels.filter((l) => l !== k) })}
            search={(q) => api.forgeLabels(repoId, draft.targetRemote, q).then((l) => l.map(labelOption))}
            onPick={(l) => { setColors((c) => ({ ...c, [l.name]: l.color })); update({ ...draft, labels: [...draft.labels, l.name] }); }}
          />
          <label className="modal-check">
            <input type="checkbox" checked={draft.draft} onChange={(e) => update({ ...draft, draft: e.target.checked })} /> Mark as draft
          </label>
          {kind === 'gitlab' && (
            <>
              <label className="modal-check">
                <input type="checkbox" checked={squash.locked ? squash.value : !!draft.squash} disabled={squash.locked} onChange={(e) => update({ ...draft, squash: e.target.checked })} /> Squash commits when merging
              </label>
              {squash.caption && <p className="create-mr-hint">{squash.caption}</p>}
              <label className="modal-check">
                <input type="checkbox" checked={!!draft.deleteSourceBranch} onChange={(e) => update({ ...draft, deleteSourceBranch: e.target.checked })} /> Delete the source branch when merged
              </label>
            </>
          )}
          <div className="modal-actions create-mr-actions">
            {saved && <button type="button" onClick={() => { void discard(); }}>Discard draft</button>}
            <button type="button" onClick={continueOnForge}>Continue editing on {forgeName(kind)}</button>
            <button type="button" className="primary" disabled={!!blocked || busy} onClick={() => { void submit(); }}>{busy ? 'Creating…' : `Create ${noun}`}</button>
          </div>
          {/* Under the action row, so a message coming or going never moves the buttons. */}
          {routeError && <p className="create-mr-error" role="alert">{routeError}</p>}
          {error && <p className="create-mr-error" role="alert">{error}</p>}
          {blocked && onRemote && <p className="create-mr-hint" role="status">{blocked}</p>}
        </fieldset>
      </form>
      {picking && (
        <RefPicker
          anchor={picking}
          items={targets.map((n) => ({ id: n, label: n, current: n === draft.targetBranch }))}
          placeholder="Target branch"
          onPick={(item) => { setPicking(null); move({ targetBranch: item.id }); }}
          onClose={() => setPicking(null)}
        />
      )}
    </FlyoutFrame>
  );
}

registerKeyHints([
  { id: 'key.mrCreate', section: 'Merge request', label: 'Create the merge/pull request', keys: ['Ctrl+Enter'], context: '(when writing the title or description)', source: 'forge/create/CreateMrFlyout.tsx' },
]);
