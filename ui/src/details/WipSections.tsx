import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { countByStatus } from '../files/fileTree';
import { FileList, StatusCountsView, useFileRowH, type FileListHandle } from '../files/FileList';
import { PathTreeToggle } from '../files/PathTreeToggle';
import { filesKey } from '../repo/services';
import type { FileSection } from '../repo/store';
import { loadWipPanel, saveWipPanel, WIP_PANEL, wipSplitBounds, type WipPanelPrefs } from './wipPanelPrefs';
import { SplitResizer } from './SplitResizer';

type Which = 'unstaged' | 'staged';

/** One section: a header that collapses it (title and count, then its change summary and the
 * +/− totals on the same line), and its file list, with Path/Tree left to the shared toggle. */
function WipSection({ section, which, collapsed, onToggle, sizeRef, basis, listRef, onLeave }: {
  section: FileSection;
  which: Which;
  collapsed: boolean;
  onToggle: () => void;
  sizeRef?: React.Ref<HTMLElement>;
  basis?: number;
  listRef: Ref<FileListHandle>;
  onLeave: (dir: 1 | -1) => boolean;
}) {
  const label = section.title ?? which;
  const list = section.list;
  const ready = list.status === 'ready' ? list.data : null;
  const counts = ready ? countByStatus(ready.files) : null;
  // A collapsed section stays mounted, hidden, so its folders and keyboard cursor survive.
  let body: ReactNode = null;
  if (ready) body = <FileList ref={listRef} list={ready} spec={section.spec} label={label} sharedMode onLeave={onLeave} />;
  else if (list.status === 'error' && !collapsed) body = <div role="alert" className="file-section-status">{list.message}</div>;
  return (
    <section
      ref={sizeRef}
      className={`file-section wip-section${collapsed ? ' collapsed' : ''}${basis !== undefined ? ' sized' : ''}`}
      aria-label={label}
      data-section={which}
      style={basis !== undefined ? { flexBasis: `${basis * 100}%` } : undefined}
    >
      {/* The whole bar toggles; the button inside is its keyboard (and screen reader) face. */}
      <div className="wip-section-head" onClick={onToggle}>
        <h3 className="file-section-title">
          <button type="button" aria-expanded={!collapsed}>
            {collapsed ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
            {label}{ready && ` (${ready.files.length})`}
          </button>
        </h3>
        {counts && <span className="wip-section-summary"><StatusCountsView counts={counts} testId={`${which}-counts`} size={12} /></span>}
        {ready && (ready.added > 0 || ready.deleted > 0) && (
          // Like the per-type counts (K47), a zero side is not shown: an empty section shows no totals (K86).
          <span className="file-totals" data-testid={`${which}-totals`}>
            {ready.added > 0 && <span className="added">+{ready.added}</span>}
            {ready.added > 0 && ready.deleted > 0 && ' '}
            {ready.deleted > 0 && <span className="deleted">−{ready.deleted}</span>}
          </span>
        )}
      </div>
      <div className="wip-section-body" hidden={collapsed}>{body}</div>
    </section>
  );
}

/**
 * The WIP row's two file lists (spec §8.6, K36): one shared Path/Tree toggle on top, then
 * "Unstaged (n)" and "Staged (n)", each collapsible in place from its header. While
 * both are expanded, a drag handle (the details split's, rAF-coalesced) sets the split; a
 * collapsed section shrinks to its header and the other takes the space. The ratio and the
 * collapsed state persist.
 */
export function WipSections({ sections }: { sections: FileSection[] }) {
  const [prefs, setPrefs] = useState<WipPanelPrefs>(loadWipPanel);
  const ref = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setHeight(el.clientHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rowH = useFileRowH();
  const bounds = wipSplitBounds(height, rowH);
  const shown = Math.max(bounds[0], Math.min(bounds[1], prefs.ratio));
  const update = (next: WipPanelPrefs) => { setPrefs(next); saveWipPanel(next); };
  const toggle = (which: Which) => update({ ...prefs, collapsed: { ...prefs.collapsed, [which]: !prefs.collapsed[which] } });
  const [unstaged, staged] = sections;
  const lists = { unstaged: useRef<FileListHandle>(null), staged: useRef<FileListHandle>(null) };
  // Up/down run on through both expanded sections, Unstaged then Staged, wrapping at the ends:
  // past one list's end the other takes over, unless it's collapsed or empty (then false, and
  // the list wraps on its own).
  const leave = (from: Which) => (dir: 1 | -1) => {
    const to: Which = from === 'unstaged' ? 'staged' : 'unstaged';
    const h = lists[to].current;
    if (prefs.collapsed[to] || !h?.hasFiles()) return false;
    h.enter(dir === 1 ? 'first' : 'last');
    return true;
  };
  const both = !prefs.collapsed.unstaged && !prefs.collapsed.staged;
  return (
    <div ref={ref} className="wip-sections">
      <div className="wip-view-bar"><PathTreeToggle /></div>
      <WipSection key={filesKey(unstaged.spec)} section={unstaged} which="unstaged" collapsed={prefs.collapsed.unstaged} onToggle={() => toggle('unstaged')} listRef={lists.unstaged} onLeave={leave('unstaged')} sizeRef={topRef} basis={both ? shown : undefined} />
      {both && (
        <SplitResizer
          ratio={shown}
          bounds={bounds}
          height={height}
          onChange={(ratio) => setPrefs((p) => ({ ...p, ratio }))}
          onCommit={(ratio) => saveWipPanel({ ...prefs, ratio })}
          targetRef={topRef}
          label="Resize unstaged and staged files"
          step={WIP_PANEL.step}
          defaultRatio={WIP_PANEL.defaultRatio}
        />
      )}
      <WipSection key={filesKey(staged.spec)} section={staged} which="staged" collapsed={prefs.collapsed.staged} onToggle={() => toggle('staged')} listRef={lists.staged} onLeave={leave('staged')} />
    </div>
  );
}
