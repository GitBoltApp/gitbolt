import { Check, ChevronDown, GitBranch } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { selectCommit } from '../app/graphNav';
import { useRepoContext } from '../app/repoContext';
import { useRuntime } from '../app/runtime';
import { HoverTooltip } from '../ui/HoverTooltip';
import { RefPicker, type PickItem } from '../ui/RefPicker';
import { useToast } from '../ui/toast';

const NO_BRANCHES: never[] = [];

/** Spec §6.3: the current branch, and a searchable list of the local branches. Picking one jumps
 * to its tip in the graph (checking it out is #2's). */
export function BranchPicker() {
  const { tabId } = useRepoContext();
  const head = useRuntime((s) => s.tabs[tabId]?.graph?.head);
  const locals = useRuntime((s) => s.tabs[tabId]?.sidebar?.locals) ?? NO_BRANCHES;
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const label = head?.branch?.replace(/^refs\/heads\//, '') ?? (head?.target ? `HEAD (${head.target.slice(0, 7)})` : '—');
  const items = useMemo<PickItem[]>(() => locals.map((b) => ({
    id: b.fullName, label: b.name, icon: b.isHead ? Check : GitBranch, current: b.isHead,
    detail: b.ahead || b.behind ? `${b.ahead}↑ ${b.behind}↓` : undefined,
  })), [locals]);
  // Back to the button (Esc), as a menu does; a press elsewhere then moves the focus on itself.
  const close = useCallback(() => {
    setAnchor(null);
    button.current?.focus({ preventScroll: true });
  }, []);
  const pick = (item: PickItem) => {
    setAnchor(null);
    const b = locals.find((l) => l.fullName === item.id);
    if (b && !selectCommit(tabId, b.target, { focus: true })) useToast.getState().show('Not in the loaded history');
  };
  return (
    <>
      <HoverTooltip content="Jump to a local branch">
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
      {anchor && <RefPicker anchor={anchor} ignore={button.current} placeholder="Find a local branch" items={items} onClose={close} onPick={pick} />}
    </>
  );
}
