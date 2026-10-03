import { Activity, useEffect } from 'react';
import { GitTooOldScreen } from '../errors/GitTooOldScreen';
import { useGitCheck } from '../errors/gitCheck';
import { ContextMenu } from '../menu/ContextMenu';
import { ArmLayer } from '../ui/arm/ArmLayer';
import { ChoiceDialog } from '../ui/ChoiceDialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { PromptDialog } from '../ui/PromptDialog';
import { Toast } from '../ui/Toast';
import { TooltipHost } from '../ui/TooltipHost';
import './features';
import { useGlobalEvents } from './ops';
import { RepoTab } from './RepoTab';
import { useRuntime } from './runtime';
import { useGlobalShortcuts } from './shortcuts';
import { AppSlot, TabSlot } from './slots';
import { useAppState } from './state';
import { openBlankTab } from './tabs';
import './shell.css';

/** Closed tabs (and a previous profile's) let go of their runtime and 1B view state. */
function useDropClosedTabs() {
  const tabs = useAppState((s) => s.profile.tabs);
  useEffect(() => {
    const open = new Set(tabs.map((t) => t.id));
    const rt = useRuntime.getState();
    for (const id of Object.keys(rt.tabs)) if (!open.has(id)) rt.drop(id);
  }, [tabs]);
}

/**
 * The app shell (spec §6): the header slot (the tab bar), every tab of the active profile inside
 * `<Activity>` (only the active one visible; the hidden ones do no work, spec §4.4), the status
 * bar and overlay slots, and the app's one toast, context menu and tooltip (spec §7).
 */
export function AppShell({ error = null }: { error?: string | null }) {
  useGlobalShortcuts();
  // Op and auth events (fetch/clone progress, askpass prompts) for the status bar and the auth
  // modal: app-wide, whichever tab is showing.
  useGlobalEvents();
  useDropClosedTabs();
  const gitProblem = useGitCheck((s) => s.problem);
  const loaded = useAppState((s) => s.loaded);
  const tabs = useAppState((s) => s.profile.tabs);
  const activeTab = useAppState((s) => s.profile.activeTab);
  const profileId = useAppState((s) => s.profile.id);
  // A stale active id (a tab removed elsewhere) still shows a tab, and is repaired to it below,
  // so the shortcuts (which act on `profile.activeTab`) target the tab on screen.
  const active = tabs.some((t) => t.id === activeTab) ? activeTab : tabs[0]?.id ?? null;
  useEffect(() => {
    if (loaded && active !== activeTab) useAppState.getState().updateProfile((p) => ({ ...p, activeTab: active }));
  }, [loaded, active, activeTab]);
  // No tab open: show the Open Repository screen (spec §13), once boot has opened any launch repos.
  const booted = useAppState((s) => s.booted);
  useEffect(() => {
    if (booted && tabs.length === 0) useAppState.getState().updateProfile((p) => openBlankTab(p).profile);
  }, [booted, tabs.length]);
  useEffect(() => {
    if (loaded && tabs.length === 0) document.title = 'GitBolt';
  }, [loaded, tabs.length]);
  return (
    <div className="app-shell">
      {gitProblem ? (
        <GitTooOldScreen error={gitProblem} />
      ) : error ? (
        <div className="center-message" role="alert">{error}</div>
      ) : !loaded ? (
        <div className="center-message">Loading…</div>
      ) : (
        <>
          <AppSlot name="header" />
          {/* Keyed by profile: switching profile swaps the whole tab set (spec §14.1). */}
          <div className="tab-stack" key={profileId}>
            {tabs.map((t) => (
              <Activity key={t.id} mode={t.id === active ? 'visible' : 'hidden'}>
                <div className="tab-page" data-tab-id={t.id}>
                  {t.kind === 'repo' ? <RepoTab tab={t} /> : <TabSlot name="openTab" tab={t} />}
                </div>
              </Activity>
            ))}
          </div>
          <AppSlot name="statusBar" />
          <AppSlot name="overlay" />
        </>
      )}
      <Toast />
      {/* The one context menu and its tooltip (spec §7). */}
      <ContextMenu />
      <TooltipHost />
      {/* Confirms (spec §ui confirms): the armed control's overlay, and the anchored popovers. */}
      <ArmLayer />
      <ConfirmDialog />
      <PromptDialog />
      <ChoiceDialog />
    </div>
  );
}
