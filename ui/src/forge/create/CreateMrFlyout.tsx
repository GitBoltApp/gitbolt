import { ChevronDown, ExternalLink, FileText, GitPullRequest, GitPullRequestDraft } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../../api/client';
import type { CreateContext } from '../../api/gen/CreateContext';
import type { ForgeLabel } from '../../api/gen/ForgeLabel';
import type { ForgeUser } from '../../api/gen/ForgeUser';
import { copyText } from '../../api/transport';
import { useRuntime } from '../../app/runtime';
import { GitHubMark, GitLabMark } from '../../icons/brands';
import { MarkdownField } from '../../markdown/MarkdownField';
import { openMenuAt } from '../../menu/menuStore';
import type { MenuRow } from '../../menu/types';
import { stackBase, stackFor, stacksOf } from '../../stacks/detect';
import { registerKeyHints } from '../../shortcuts/hints';
import { openPushUpstream, pushBranch } from '../../sync/push';
import { confirmAction } from '../../ui/ConfirmDialog';
import { FlyoutFrame } from '../../ui/flyout/FlyoutFrame';
import { flyoutOf, type FlyoutProps } from '../../ui/flyout/flyout';
import { RefPicker } from '../../ui/RefPicker';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { useToast } from '../../ui/toastStore';
import { writeCtx } from '../../write/ctx';
import { forgeName, mrLongNoun } from '../labels';
import { forgeOf } from '../mrStore';
import { mappedRemotes } from '../projects';
import { BranchFlow, FlowStrip } from '../ui/BranchFlow';
import { useCommitJump } from '../ui/commitJump';
import { PeopleCard, type PeopleChip, type PeopleRow } from '../ui/PeopleCard';
import { useRangeStats } from '../ui/rangeStats';
import { notifyForgeWrite } from '../usePolling';
import { discardMrDraft, flushMrDrafts, mrDraftKey, readMrDraft, useMrDrafts, writeMrDraft, type MrDraft } from './draft';
import { newMrUrl } from './newMrUrl';
import { showCreated } from './outcome';
import { createBlocked, createRequest, defaultTarget, freshDraft, pushedAs, sourceBranchOf, squashToggle, unpushedCount, withTemplate, type Route } from './prefill';
import type { PickOption } from './SearchPicker';
import { labelListLimit, labelsSource, mapSource, peopleSource } from '../pickerCache';
import { limitTip, maxOf, usePeopleLimits } from '../peopleLimits';
import type { CreateMrArgs } from './store';
import './createMr.css';

const NO_FORGE = "No forge account for this repository's remotes: add one in Settings › Accounts";

const userOption = (u: ForgeUser): PickOption<ForgeUser> => ({ key: String(u.id), label: u.name, detail: `@${u.username}`, value: u });
const labelOption = (l: ForgeLabel): PickOption<ForgeLabel> => ({ key: l.name, label: l.name, color: l.color, value: l });
const userChip = (u: ForgeUser): PeopleChip => ({ key: String(u.id), label: u.name, user: u });

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
  // MR round 2: a project that allows one reviewer or assignee (GitLab Free) swaps on a pick.
  const limits = usePeopleLimits(repoId, draft?.targetRemote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<DOMRect | null>(null);
  const [colors, setColors] = useState<Record<string, string | null>>({});
  const [loaded, setLoaded] = useState<Route | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const goodRoute = useRef<Route | null>(null);
  const [me, setMe] = useState<ForgeUser | null>(null);
  const latest = useRef<MrDraft | null>(null);
  latest.current = draft;
  const local = sidebar?.locals.find((b) => b.name === branch);
  // What the branch brings over its target: counted locally (merge base, then the compare list).
  const jump = useCommitJump(tabId);
  const stats = useRangeStats(tabId, local?.target ?? null, route ? `refs/remotes/${route.targetRemote}/${route.targetBranch}` : null);
  // "Assign to me": the account's own user on the target's host.
  const host = ctx?.project.host;
  useEffect(() => {
    if (!host) return;
    let live = true;
    api.forgeAccounts().then((a) => { if (live) setMe(a.find((x) => x.account.host === host)?.account.user ?? null); }, () => {});
    return () => { live = false; };
  }, [host]);
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
    if (!f.remote || !rt?.repo) { setProblem(NO_FORGE); return; }
    if (!f.project) { setProblem(f.error ?? NO_FORGE); return; }
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
      <FlyoutFrame
        label={title}
        title={title}
        onClose={close}
        footer={saved && <div className="create-mr-actions"><span className="create-mr-spacer" /><button type="button" className="create-mr-ghost" onClick={() => { void discardSaved(); }}>Discard draft</button></div>}
      >
        <p className="create-mr-problem" role="alert">{problem}</p>
      </FlyoutFrame>
    );
  }
  if (!ctx || !draft || !route || repoId === undefined || !repoPath) return <FlyoutFrame label={title} title={title} onClose={close}><p className="create-mr-loading">Loading…</p></FlyoutFrame>;

  const kind = ctx.project.kind;
  const noun = mrLongNoun(kind);
  const loading = loaded !== route;
  const update = (next: MrDraft) => { setDraft(next); setError(null); writeMrDraft(repoPath, branch, next); };
  // A change from a picker's answer: onto the draft as it is by then, not as it was when the search began.
  const patch = (f: (d: MrDraft) => MrDraft) => update(f(latest.current ?? draft));
  const move = (change: Partial<Route>) => {
    const next = { ...route, ...change };
    setRouteError(null);
    if (saved) update({ ...draft, ...next });
    else setDraft({ ...draft, ...next });
    setRoute(next);
  };
  const names = (sidebar?.remotes ?? []).map((g) => g.name);
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
  const templateName = ctx.templates.find((t) => t.path === draft.template)?.name ?? 'none';

  const submit = async (d: MrDraft = draft) => {
    if (blocked || busy) return;
    const req = createRequest(d, ctx, sourceBranch);
    // The create outlives this mount (Esc or × during "Creating…"): it closes only the flyout it
    // was started from, and a failure after an unmount goes to a toast.
    const mine = flyoutOf(tabId)?.seq;
    const sent = d;
    // The fieldset disables what has the focus: it goes back there once the form is editable again.
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusy(true);
    setError(null);
    try {
      const out = await api.forgeCreateMr(repoId, d.targetRemote, req);
      discardMrDraft(repoPath, branch);
      if (flyoutOf(tabId)?.seq === mine) closeFrame();
      showCreated({ repoId, remote: d.targetRemote, kind, req, number: out.mr.number, webUrl: out.mr.webUrl }, out.failed);
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
  // The split button's ▾: create as draft (or not). The choice is kept in the draft, so a failed
  // create (or a reopen) offers the same again on the main button.
  const createAs = (asDraft: boolean) => {
    const next = { ...draft, draft: asDraft };
    if (asDraft !== draft.draft) update(next);
    void submit(next);
  };
  const createMenu = (el: HTMLElement) => {
    const rows = (): MenuRow[] => [
      { kind: 'action', id: 'create.ready', label: `Create ${noun}`, icon: GitPullRequest, tooltip: `Create the ${noun}, ready for review`, run: () => createAs(false) },
      { kind: 'action', id: 'create.draft', label: 'Create as draft', icon: GitPullRequestDraft, tooltip: `Create the ${noun} as a draft`, run: () => createAs(true) },
    ];
    openMenuAt(el, rows(), draft.draft ? 'create.draft' : 'create.ready', rows, 'Create options');
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
  const searchUsers = (add: (d: MrDraft, u: ForgeUser) => MrDraft) =>
    mapSource(peopleSource(repoId, draft.targetRemote, (q) => api.forgeSearchUsers(repoId, draft.targetRemote, q)), (u) => ({ ...userOption(u), value: () => patch((d) => add(d, u)) }));
  const labelPicker = mapSource(labelsSource(repoId, draft.targetRemote, labelListLimit(kind), (q) => api.forgeLabels(repoId, draft.targetRemote, q)), (l) => ({
    ...labelOption(l), value: () => { setColors((c) => ({ ...c, [l.name]: l.color })); patch((d) => (d.labels.includes(l.name) ? d : { ...d, labels: [...d.labels, l.name] })); },
  }));
  const assigned = !!me && draft.assignees.some((u) => u.id === me.id);
  // The forge's caps: one replaces whoever is there; at a higher cap, + is off (PeopleCard).
  const [maxReviewers, maxAssignees] = [maxOf(limits, 'reviewers'), maxOf(limits, 'assignees')];
  const added = (list: ForgeUser[], u: ForgeUser, max: number | null) => (max === 1 ? [u] : [...list, u]);
  const people: PeopleRow[] = [
    {
      label: 'Reviewers', noun: 'reviewer', chips: draft.reviewers.map(userChip),
      edit: {
        ...searchUsers((d, u) => ({ ...d, reviewers: added(d.reviewers, u, maxReviewers) })),
        onRemove: (k) => patch((d) => ({ ...d, reviewers: d.reviewers.filter((u) => String(u.id) !== k) })),
        max: maxReviewers, maxTip: maxReviewers !== null ? limitTip(kind, 'reviewers', maxReviewers) : undefined,
      },
    },
    {
      label: 'Assignees', noun: 'assignee', chips: draft.assignees.map(userChip),
      edit: {
        ...searchUsers((d, u) => ({ ...d, assignees: added(d.assignees, u, maxAssignees) })),
        onRemove: (k) => patch((d) => ({ ...d, assignees: d.assignees.filter((u) => String(u.id) !== k) })),
        // Kept in the row once assigned (hidden, not removed), so the row never reflows.
        extra: me && <button type="button" className="people-me" style={assigned ? { visibility: 'hidden' } : undefined} aria-hidden={assigned || undefined} tabIndex={assigned ? -1 : undefined} onClick={() => patch((d) => (d.assignees.some((u) => u.id === me.id) ? d : { ...d, assignees: added(d.assignees, me, maxAssignees) }))}>Assign to me</button>,
        max: maxAssignees, maxTip: maxAssignees !== null ? limitTip(kind, 'assignees', maxAssignees) : undefined,
      },
    },
    {
      label: 'Labels', noun: 'label', chips: draft.labels.map((l) => ({ key: l, label: l, color: colors[l] ?? null })),
      edit: {
        ...labelPicker,
        onRemove: (k) => patch((d) => ({ ...d, labels: d.labels.filter((l) => l !== k) })),
      },
    },
  ];
  const strip = !onRemote
    ? (
      <FlowStrip action={local && (
        <button type="button" className="flow-strip-btn" aria-label={`Push ${branch}${pushElsewhere ? '…' : ''}`} onClick={() => { const w = writeCtx(tabId); if (w) void (pushElsewhere ? openPushUpstream : pushBranch)(w, local); }}>Push{pushElsewhere ? '…' : ''}</button>
      )}>
        <code>{sourceBranch}</code> isn't on {draft.sourceRemote} yet.
      </FlowStrip>
    )
    : unpushed !== 0
      ? (
        <FlowStrip>
          {unpushed === null ? `${branch} differs from ${draft.sourceRemote}/${sourceBranch}` : `${unpushed === 1 ? "1 commit isn't" : `${unpushed} commits aren't`} pushed yet`}: the {noun} shows what {draft.sourceRemote} has
        </FlowStrip>
      )
      : null;
  const fromFirstCommit = !!ctx.firstCommit?.summary && draft.title === ctx.firstCommit.summary;
  const createLabel = draft.draft ? `Create draft ${noun}` : `Create ${noun}`;
  const heading = (
    <>
      <span className="create-mr-mark" data-kind={kind}>{kind === 'gitlab' ? <GitLabMark size={16} /> : <GitHubMark size={16} />}</span>
      <span className="create-mr-heading">New {noun}</span>
      <span className="create-mr-project">{ctx.project.path}</span>
    </>
  );
  const footer = (
    <div className="create-mr-foot">
      {/* Above the buttons, in the pinned footer: always in view, and the buttons never move. */}
      {(routeError || error || (blocked && onRemote)) && (
        <div className="create-mr-messages">
          {routeError && <p className="create-mr-error" role="alert">{routeError}</p>}
          {error && <p className="create-mr-error" role="alert">{error}</p>}
          {blocked && onRemote && <p className="create-mr-hint" role="status">{blocked}</p>}
        </div>
      )}
      <div className="create-mr-actions">
        <button type="button" className="create-mr-ghost" disabled={busy} onClick={continueOnForge}>Continue on {forgeName(kind)} <ExternalLink size={12} aria-hidden /></button>
        {saved && <button type="button" className="create-mr-ghost" disabled={busy} onClick={() => { void discard(); }}>Discard draft</button>}
        <span className="create-mr-spacer" />
        <span className="create-mr-split">
          <button type="button" className="create-mr-primary" disabled={!!blocked || busy} onClick={() => { void submit(); }}>{busy ? 'Creating…' : createLabel}</button>
          <button type="button" className="create-mr-caret" aria-label="More create options" aria-haspopup="menu" disabled={!!blocked || busy} onClick={(e) => createMenu(e.currentTarget)}><ChevronDown size={13} aria-hidden /></button>
        </span>
      </div>
    </div>
  );

  return (
    <FlyoutFrame label={title} title={heading} onClose={close} footer={footer}>
      {/* Only Ctrl+Enter and the Create button create (an irreversible forge write): Enter never submits. */}
      <form onSubmit={(e) => e.preventDefault()}>
        {/* Read-only while "Creating…": what's sent is what's shown. */}
        <fieldset className="create-mr" disabled={busy}>
          <BranchFlow
            from={{ branch: sourceBranch, sub: <Select aria-label="Source remote" value={draft.sourceRemote} options={remoteOptions} onChange={(v) => move({ sourceRemote: v })} /> }}
            into={{ branch: draft.targetBranch, sub: <Select aria-label="Target remote" value={draft.targetRemote} options={remoteOptions} onChange={(v) => move({ targetRemote: v })} />, pick: { label: 'Target branch', onPick: setPicking } }}
            stats={stats}
            count={ctx.firstCommit?.count ?? null}
            none={`${draft.targetRemote}/${draft.targetBranch} isn't fetched: no counts yet`}
            strip={strip}
            jump={jump}
          />
          <label className="create-mr-field">
            <span className="create-mr-label">Title{fromFirstCommit && <span className="create-mr-label-hint">from the first commit</span>}</span>
            <input className="create-mr-title" aria-label="Title" value={draft.title} spellCheck autoComplete="off" autoFocus onChange={(e) => update({ ...draft, title: e.target.value })} onKeyDown={fieldKeys} onBlur={flushMrDrafts} />
          </label>
          {/* --- 5A T9: Write / Preview --- */}
          <div className="create-mr-field">
            <span className="create-mr-label">Description{ctx.templatesLocal && <span className="create-mr-label-hint">Templates from the local copy of {draft.targetBranch}</span>}</span>
            <MarkdownField
              label="Description"
              rows={10}
              value={draft.description}
              spellCheck
              flavor={kind}
              context={{ kind: 'forge', tabId }}
              onChange={(v) => update({ ...draft, description: v })}
              onKeyDown={fieldKeys}
              onBlur={flushMrDrafts}
              toolbar={<Select aria-label="Template" value={draft.template ?? ''} options={templateOptions} shown={<><FileText size={13} aria-hidden /> Template: {templateName}</>} onChange={(v) => { void chooseTemplate(v); }} />}
            />
          </div>
          {/* --- end 5A T9 --- */}
          <PeopleCard rows={people} disabled={busy} />
          {kind === 'gitlab' && (
            <div className="create-mr-field">
              <span className="create-mr-label">When merged</span>
              <div className="switch-group" role="group" aria-label="When merged">
                <Switch
                  label="Squash commits"
                  description={squash.caption ?? `One commit on ${draft.targetBranch}`}
                  checked={squash.locked ? squash.value : !!draft.squash}
                  disabled={squash.locked}
                  onChange={(v) => update({ ...draft, squash: v })}
                />
                <Switch label="Delete the source branch" description={`On ${draft.sourceRemote}, after the merge`} checked={!!draft.deleteSourceBranch} onChange={(v) => update({ ...draft, deleteSourceBranch: v })} />
              </div>
            </div>
          )}
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
  { id: 'key.mrCreate', section: 'Merge request', label: 'Create the merge/pull request', keys: ['Mod+Enter'], context: '(when writing the title or description)', source: 'forge/create/CreateMrFlyout.tsx' },
]);
