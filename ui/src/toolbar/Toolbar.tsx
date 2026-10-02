import { ChevronDown, LoaderCircle } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { actionsVersion, getAction, invoke, runAction, subscribeActions, type Action } from '../app/actions';
import { useRepoContext, type RepoCtx } from '../app/repoContext';
import { openMenuAt } from '../menu/menuStore';
import type { MenuRow } from '../menu/types';
import { HoverTooltip } from '../ui/HoverTooltip';
import { BranchPicker } from './BranchPicker';
import { DefaultPicker } from './DefaultPicker';
import { RepoButton } from './RepoButton';
import { useToolbarButtons, type ToolbarButton } from './registry';
import './toolbar.css';

const tooltipOf = (a: Action) => (a.shortcuts?.[0] ? `${a.tooltip} (${a.shortcuts[0]})` : a.tooltip);
const usable = (a: Action) => !a.when || a.when();
const notBusy = () => false;
const noView = () => null;

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
  const useQueued = b.useQueued ?? notBusy;
  const queued = useQueued(ctx);
  const useView = b.useView ?? noView;
  const view = useView(ctx);
  const [pickerAt, setPickerAt] = useState<Element | null>(null);
  const a = getAction(b.action);
  if (!a) return null;
  const label = view?.label ?? b.label ?? a.label;
  const Icon = busy ? LoaderCircle : a.icon;
  const tip = view?.tooltip ?? tooltipOf(a);
  // Off but hoverable (aria-disabled, not `disabled`): its tooltip says why (spec #2 §5.5).
  const off = view ? view.disabled : !usable(a);
  const button = (
    <HoverTooltip content={tip}>
      <button type="button" className="tb-btn" aria-label={label} aria-busy={busy || undefined} disabled={busy} aria-disabled={off || undefined} onClick={() => { if (!off) runAction(a.id); }}>
        <Icon size={16} className={busy ? 'spin' : undefined} aria-hidden />
        <span>{label}</span>
        {queued && <span className="tb-queued" aria-hidden />}
      </button>
    </HoverTooltip>
  );
  if (!b.menu?.length && !b.picker && !b.menuRows) return button;
  const openCaret = (el: HTMLElement) => {
    if (b.picker) return setPickerAt(el);
    const build = () => (b.menuRows ? b.menuRows(ctx) : menuRows(b.menu ?? []));
    openMenuAt(el, build(), undefined, build, `${label} options`);
  };
  return (
    <div className="tb-split">
      {button}
      <HoverTooltip content={`${label} options`}>
        <button type="button" className="tb-btn tb-caret" aria-label={`${label} options`} aria-haspopup="menu" onClick={(e) => openCaret(e.currentTarget)}>
          <ChevronDown size={12} aria-hidden />
        </button>
      </HoverTooltip>
      {pickerAt && b.picker && <DefaultPicker picker={b.picker} anchor={pickerAt} onClose={() => setPickerAt(null)} />}
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
  const buttons = useToolbarButtons((s) => s.buttons);
  // DOM order is the visual order: the centre group, then the end group at the far right.
  const center = buttons.filter((b) => (b.placement ?? 'center') === 'center');
  const end = buttons.filter((b) => b.placement === 'end');
  // Re-render when actions register or go: a button's action may arrive after the toolbar mounted.
  useSyncExternalStore(subscribeActions, actionsVersion);
  return (
    <div className="toolbar" role="toolbar" aria-label="Repository toolbar">
      <RepoButton />
      <BranchPicker />
      <div className="tb-spacer" />
      {center.map((b) => <ToolbarButtonView key={b.action} b={b} ctx={ctx} />)}
      <div className="tb-spacer" />
      {end.map((b) => <ToolbarButtonView key={b.action} b={b} ctx={ctx} />)}
    </div>
  );
}
