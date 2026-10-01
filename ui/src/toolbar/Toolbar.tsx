import { ChevronDown, LoaderCircle } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { actionsVersion, getAction, invoke, runAction, subscribeActions, type Action } from '../app/actions';
import { useRepoContext, type RepoCtx } from '../app/repoContext';
import { useRuntime } from '../app/runtime';
import { openMenuAt } from '../menu/menuStore';
import type { MenuRow } from '../menu/types';
import { HoverTooltip } from '../ui/HoverTooltip';
import { BranchPicker } from './BranchPicker';
import { useToolbarButtons, type ToolbarButton } from './registry';
import './toolbar.css';

const tooltipOf = (a: Action) => (a.shortcuts?.[0] ? `${a.tooltip} (${a.shortcuts[0]})` : a.tooltip);
const usable = (a: Action) => !a.when || a.when();
const notBusy = () => false;

/** A split button's dropdown: its actions as menu rows (the usable ones). */
function menuRows(ids: string[]): MenuRow[] {
  return ids.flatMap((id) => {
    const a = getAction(id);
    return a && usable(a) ? [{ kind: 'action' as const, id: a.id, label: a.label, icon: a.icon, tooltip: a.tooltip, shortcut: a.shortcuts?.[0], run: () => invoke(a) }] : [];
  });
}

function ToolbarButtonView({ b, ctx }: { b: ToolbarButton; ctx: RepoCtx }) {
  // Called on every render (a registration's hook never changes), before any return.
  const useBusy = b.useBusy ?? notBusy;
  const busy = useBusy(ctx);
  const a = getAction(b.action);
  if (!a) return null;
  const label = b.label ?? a.label;
  const Icon = busy ? LoaderCircle : a.icon;
  const button = (
    <HoverTooltip content={tooltipOf(a)}>
      <button type="button" className="tb-btn" aria-label={label} aria-busy={busy || undefined} disabled={busy || !usable(a)} onClick={() => runAction(a.id)}>
        <Icon size={16} className={busy ? 'spin' : undefined} aria-hidden />
        <span>{label}</span>
      </button>
    </HoverTooltip>
  );
  if (!b.menu?.length) return button;
  const menu = b.menu;
  return (
    <div className="tb-split">
      {button}
      <HoverTooltip content={`${label} options`}>
        <button type="button" className="tb-btn tb-caret" aria-label={`${label} options`} aria-haspopup="menu" onClick={(e) => openMenuAt(e.currentTarget, menuRows(menu), undefined, () => menuRows(menu), `${label} options`)}>
          <ChevronDown size={12} aria-hidden />
        </button>
      </HoverTooltip>
    </div>
  );
}

/**
 * The repo tab's toolbar (spec §6.3), in the tab's `toolbar` slot. #1 shows only the controls that
 * work: the repository, the branch picker, then the registered buttons (`registry.ts`): Fetch
 * here; Search and Actions join from find's and the palette's own modules.
 */
export function Toolbar() {
  const ctx = useRepoContext();
  const name = useRuntime((s) => s.tabs[ctx.tabId]?.repo?.name);
  const buttons = useToolbarButtons((s) => s.buttons);
  // DOM order is the visual order: the centre group, then the end group at the far right.
  const center = buttons.filter((b) => (b.placement ?? 'center') === 'center');
  const end = buttons.filter((b) => b.placement === 'end');
  // Re-render when actions register or go: a button's action may arrive after the toolbar mounted.
  useSyncExternalStore(subscribeActions, actionsVersion);
  return (
    <div className="toolbar" role="toolbar" aria-label="Repository toolbar">
      <div className="tb-field">
        <span className="tb-caption">repository</span>
        <span className="tb-value">{name}</span>
      </div>
      <BranchPicker />
      <div className="tb-spacer" />
      {center.map((b) => <ToolbarButtonView key={b.action} b={b} ctx={ctx} />)}
      <div className="tb-spacer" />
      {end.map((b) => <ToolbarButtonView key={b.action} b={b} ctx={ctx} />)}
    </div>
  );
}
