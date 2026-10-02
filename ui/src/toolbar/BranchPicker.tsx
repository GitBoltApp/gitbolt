import { ArrowDownAZ, Check, ChevronDown, Clock, GitBranch } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { checkoutLocal } from '../branches/checkout';
import { useRepoContext } from '../app/repoContext';
import { useRuntime } from '../app/runtime';
import { HoverTooltip } from '../ui/HoverTooltip';
import { RefPicker, type PickItem } from '../ui/RefPicker';

const NO_BRANCHES: never[] = [];

/** K72: the picker's order, alphabetical (the default) or most recent tip first; remembered. */
type Order = 'alpha' | 'recent';
const ORDER_KEY = 'gitbolt.branchPickerOrder.v1';
function loadOrder(): Order {
  try {
    return localStorage.getItem(ORDER_KEY) === 'recent' ? 'recent' : 'alpha';
  } catch {
    return 'alpha';
  }
}
function saveOrder(o: Order): void {
  try {
    localStorage.setItem(ORDER_KEY, o);
  } catch {
    /* a private window: the order just isn't remembered */
  }
}
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** Spec §6.3: the current branch, and a searchable list of the local branches. Picking one checks it out (spec #2 §19 item 5). */
export function BranchPicker() {
  const { tabId } = useRepoContext();
  const head = useRuntime((s) => s.tabs[tabId]?.graph?.head);
  const locals = useRuntime((s) => s.tabs[tabId]?.sidebar?.locals) ?? NO_BRANCHES;
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const label = head?.branch?.replace(/^refs\/heads\//, '') ?? (head?.target ? `HEAD (${head.target.slice(0, 7)})` : '—');
  const [order, setOrder] = useState<Order>(loadOrder);
  const items = useMemo<PickItem[]>(() => {
    const sorted = [...locals].sort((a, b) => (order === 'recent' ? b.tipTime - a.tipTime || byName(a.name, b.name) : byName(a.name, b.name)));
    return sorted.map((b) => ({
      id: b.fullName, label: b.name, icon: b.isHead ? Check : GitBranch, current: b.isHead,
      detail: b.ahead || b.behind ? `${b.ahead}↑ ${b.behind}↓` : undefined,
    }));
  }, [locals, order]);
  const toggle = {
    icon: order === 'alpha' ? ArrowDownAZ : Clock,
    label: order === 'alpha' ? 'Sorted A–Z: switch to most recent first' : 'Most recent first: switch to A–Z',
    onToggle: () => setOrder((o) => { const next: Order = o === 'alpha' ? 'recent' : 'alpha'; saveOrder(next); return next; }),
  };
  // Back to the button (Esc), as a menu does; a press elsewhere then moves the focus on itself.
  const close = useCallback(() => {
    setAnchor(null);
    button.current?.focus({ preventScroll: true });
  }, []);
  const pick = (item: PickItem) => {
    setAnchor(null);
    const b = locals.find((l) => l.fullName === item.id);
    if (b && !b.isHead) checkoutLocal(tabId, b.name);
  };
  return (
    <>
      <HoverTooltip content="Check out a local branch">
        <button
          ref={button}
          type="button"
          className="tb-field tb-picker"
          aria-label={`Branch: ${label}`}
          aria-haspopup="listbox"
          aria-expanded={!!anchor}
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
        >
          <span className="tb-caption">branch</span>
          <span className="tb-value"><GitBranch size={12} aria-hidden /> {label} <ChevronDown size={12} aria-hidden /></span>
        </button>
      </HoverTooltip>
      {anchor && <RefPicker anchor={anchor} ignore={button.current} placeholder="Check out a local branch" items={items} toggle={toggle} onClose={close} onPick={pick} />}
    </>
  );
}
