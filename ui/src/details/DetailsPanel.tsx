import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { CommitDetailsPayload } from '../api/gen/CommitDetailsPayload';
import type { DiffSpec } from '../api/gen/DiffSpec';
import { copyText } from '../api/transport';
import { FileList } from '../files/FileList';
import { formatDate } from '../format/date';
import { shortSha } from '../format/sha';
import { perf } from '../perf';
import { useFocusZone } from '../repo/focus';
import { filesKey } from '../repo/services';
import { useRepoView, useRepoViewStore, type FileSection, type PanelContent } from '../repo/store';
import { useToast } from '../ui/toast';
import { Avatar } from '../avatars/Avatar';
import { LARGEST_AVATAR_PX } from '../avatars/avatarStore';
import { useHoverTooltip } from '../ui/HoverTooltip';
import { CoAuthors, personLabel } from './CoAuthors';
import { CompareHeader } from './CompareHeader';
import { loadSplit, saveSplit, splitBounds } from './detailsSplit';
import { WipHeader } from './WipHeader';
import { Message, useProjectRemote } from './Message';
import { SignatureBadge } from './SignatureBadge';
import { SplitResizer } from './SplitResizer';
import './details.css';

/** A person's avatar and name; hovering shows their full `Name <email>` (feedback F14). */
function Person({ name, email, size }: { name: string; email: string; size: number }) {
  const { triggerProps, tooltip } = useHoverTooltip({ content: personLabel(name, email) });
  return (
    <span className="person-id" {...triggerProps}>
      <Avatar name={name} email={email} size={size} />
      <span className="person-name">{name}</span>
      {tooltip}
    </span>
  );
}

/** A short hash button in the header's top row, with its action as an instant tooltip (and, for
 * keyboard users, as its description; feedback H11). */
function HashButton({ hash, testId, tip, onClick }: { hash: string; testId: string; tip: string; onClick: () => void }) {
  const { triggerProps, tooltip } = useHoverTooltip({ content: tip });
  return (
    <>
      <button type="button" className="sha" data-testid={testId} aria-description={tip} onClick={onClick} {...triggerProps}>
        {shortSha(hash)}
      </button>
      {tooltip}
    </>
  );
}

/**
 * The commit header (spec §9.1). The top row is justified (feedback F16): the signature icon on
 * the left, `commit: <sha>` centred, `parent: <sha>` on the right (H11). Then the author with the committed date
 * (primary) and, only when it differs, the author date below it, dimmer (F15); a different
 * committer gets their own row, which carries the committed date; and co-authors.
 */
function CommitHeader({ d }: { d: CommitDetailsPayload }) {
  const toast = useToast((s) => s.show);
  const selectById = useRepoView((s) => s.selectCommitById);
  const committerDiffers = d.committer.name !== d.author.name || d.committer.email !== d.author.email;
  const commitDate = <span data-testid="commit-date">{formatDate(d.committer.time)}</span>;
  return (
    <header className="commit-header">
      <div className="commit-ids">
        <span className="commit-ids-start"><SignatureBadge id={d.id} signed={d.signed} /></span>
        <span className="commit-id">
          <span className="id-label">commit:</span>{' '}
          <HashButton hash={d.id} testId="details-sha" tip="Copy full SHA" onClick={() => copyText(d.id).then(() => toast('Copied'), () => toast('Copy failed'))} />
        </span>
        <span className="parents">
          {d.parents.length > 0 && <><span className="id-label">{d.parents.length > 1 ? 'parents:' : 'parent:'}</span>{' '}</>}
          {d.parents.map((p) => (
            <HashButton key={p} hash={p} testId="parent-sha" tip="Go to parent commit" onClick={() => { if (!selectById(p)) toast('Not in the loaded history'); }} />
          ))}
        </span>
      </div>
      <div className="person" data-testid="author">
        <Person name={d.author.name} email={d.author.email} size={LARGEST_AVATAR_PX} />
        <span className="person-dates">
          {!committerDiffers && commitDate}
          {d.author.time !== d.committer.time && <span data-testid="author-date" className="dim">authored {formatDate(d.author.time)}</span>}
        </span>
      </div>
      {committerDiffers && (
        // A different committer's row carries the committed date, so it isn't read as the author's.
        <div className="person" data-testid="committer">
          <Person name={d.committer.name} email={d.committer.email} size={20} />
          <span className="dim">committed</span>
          <span className="person-dates">{commitDate}</span>
        </div>
      )}
      <CoAuthors coAuthors={d.coAuthors} />
    </header>
  );
}

/**
 * The selected commit: its header from `details`, its message (§9.2) from `message` (the shared
 * `commitMessage` cache; `CommitDetailsPayload` has no message), linkified against the project
 * remote, with `Open !n` buttons. Rendered from the settled `panel` (feedback F12): both have
 * arrived (or failed) by now, so there's no placeholder frame.
 */
function CommitDetails({ panel, ratio }: { panel: PanelContent; ratio: number }) {
  const { details, message, selection } = panel;
  const row = useRepoView((s) => (selection.kind === 'commit' && s.graph.rows[selection.index]?.id === selection.id ? s.graph.rows[selection.index] : undefined));
  const remote = useProjectRemote(useRepoView((s) => s.services));
  const readyId = details.status === 'ready' && message.status === 'ready' ? details.data.id : null;
  useEffect(() => {
    if (readyId) perf.done('details');
  }, [readyId]);
  // The header stays put; only the message scrolls (feedback F13). The section's height is the
  // split's share of the panel.
  return (
    <div className="commit-details" style={{ flexBasis: `${ratio * 100}%` }}>
      {details.status === 'ready' && <CommitHeader d={details.data} />}
      {details.status === 'error' && <div role="alert" className="details-error">{details.message}</div>}
      <div className="commit-message message-box" data-testid="commit-message">
        {message.status === 'ready' ? <Message summary={message.data.summary} body={message.data.body} remote={remote} /> : (
          <>
            <h2 className="details-summary" data-testid="details-summary">{row?.summary ?? ''}</h2>
            {message.status === 'error' && <div role="alert" className="details-error">{message.message}</div>}
          </>
        )}
      </div>
    </div>
  );
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** The merge parent picker (spec §9.3): `vs 1st parent | vs 2nd parent`. */
function ParentPicker({ panel }: { panel: PanelContent }) {
  const setParent = useRepoView((s) => s.setParent);
  const { selection, details, parent } = panel;
  if (selection.kind !== 'commit' || details.status !== 'ready' || details.data.parents.length < 2) return null;
  return (
    <div className="segmented parent-picker" role="group" aria-label="Diff against parent">
      {details.data.parents.map((p, i) => (
        <button key={p} type="button" aria-pressed={parent === i} title={p} onClick={() => setParent(i)}>vs {ordinal(i + 1)} parent</button>
      ))}
    </div>
  );
}

/** The commit whose full tree "View all files" lists: the commit itself, or a compare's "to". */
const allFilesCommitFor = (spec: DiffSpec) => (spec.kind === 'commit' ? spec.id : spec.kind === 'compare' ? spec.to : null);

function FileSectionView({ section }: { section: FileSection }) {
  const label = section.title ?? 'Changed files';
  const list = section.list;
  return (
    <section className="file-section" aria-label={label}>
      {section.title && <h3 className="file-section-title">{section.title}{list.status === 'ready' && ` (${list.data.files.length})`}</h3>}
      {list.status === 'ready' ? (
        <FileList list={list.data} spec={section.spec} label={label} allFilesCommit={allFilesCommitFor(section.spec)} />
      ) : list.status === 'error' ? (
        <div role="alert" className="file-section-status">{list.message}</div>
      ) : null}
    </section>
  );
}

/** The list the files zone focuses: the one holding the open file, else the first with rows
 * (a WIP row may have only staged changes), else the first. */
function pickFileList(zone: HTMLElement): HTMLElement | null {
  return zone.querySelector<HTMLElement>('[role="listbox"][data-open-file]')
    ?? zone.querySelector<HTMLElement>('[role="listbox"]:not([data-empty])')
    ?? zone.querySelector<HTMLElement>('[role="listbox"]');
}

/**
 * The file lists (spec §9.3): the `files` focus zone. The panel mounts with its lists loaded
 * (feedback F12); a focus request made before that is applied when the zone mounts.
 *
 * While the next selection loads (`panelPending`), the lists shown are the previous
 * selection's, about to be replaced: a focus request lands on the zone itself, never in a stale
 * list (whose unmount would drop focus to `<body>`). When the lists change, focus on the zone,
 * on an empty list, or lost to `<body>` while the store names the files, moves to the right list.
 */
function FileSections({ panel }: { panel: PanelContent }) {
  const ref = useRef<HTMLDivElement>(null);
  const store = useRepoViewStore();
  const target = useCallback((el: HTMLElement) => (store.getState().panelPending ? el : pickFileList(el)), [store]);
  const zone = useFocusZone('files', ref, target);
  const sections = panel.sections;
  useEffect(() => {
    const el = ref.current;
    const active = document.activeElement;
    if (!el) return;
    const lost = (active === null || active === document.body) && store.getState().focus === 'files';
    if (!(lost || active === el || (active instanceof HTMLElement && el.contains(active) && active.matches('[role="listbox"][data-empty]')))) return;
    const list = pickFileList(el);
    if (list && list !== active) list.focus({ preventScroll: true });
    else if (!list && lost) el.focus({ preventScroll: true });
  }, [sections, store]);
  return (
    <div ref={ref} className="file-sections" tabIndex={-1} {...zone}>
      <ParentPicker panel={panel} />
      {sections.map((s) => <FileSectionView key={filesKey(s.spec)} section={s} />)}
    </div>
  );
}

/** Shown while the first Ctrl+click of a compare waits for the second (spec §9.4). */
function CompareHint({ panel }: { panel: PanelContent }) {
  return panel.marks.a !== null && panel.marks.b === null ? <div className="compare-hint">Ctrl+click another commit to compare</div> : null;
}

/** The panel's height and its commit header's, kept current by a ResizeObserver (window
 * resizes, header changes) and re-read before paint whenever the shown content changes. */
function usePanelSize(ref: RefObject<HTMLDivElement | null>, panel: PanelContent | null) {
  const [size, setSize] = useState({ height: 0, header: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const header = el.querySelector<HTMLElement>('.commit-header');
    const read = () => {
      const next = { height: el.clientHeight, header: header?.offsetHeight ?? 0 };
      setSize((s) => (s.height === next.height && s.header === next.header ? s : next));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    if (header) ro.observe(header);
    return () => ro.disconnect();
  }, [ref, panel]);
  return { ref, ...size };
}

/** The right panel: a commit's details, a compare's header, or the read-only WIP header, each
 * above the file lists (spec §9). It renders the store's settled `panel` only (feedback F12):
 * the previous selection's content stays, unchanged, until the new one's has all arrived. A
 * commit's header+message and its file list are split by a draggable, persisted divider (F13). */
export function DetailsPanel() {
  const panel = useRepoView((s) => s.panel);
  // The chosen ratio; what renders is it clamped to the measured bounds, so a taller header (a
  // committer row, co-authors) or a shorter window never squeezes the message or the file list
  // away, and the chosen ratio comes back when there's room again.
  const [ratio, setRatio] = useState(loadSplit);
  const size = usePanelSize(useRef<HTMLDivElement>(null), panel);
  const bounds = splitBounds(size.height, size.header);
  const shown = Math.max(bounds[0], Math.min(bounds[1], ratio));
  if (!panel) return null;
  const kind = panel.selection.kind;
  return (
    <div ref={size.ref} className="details-panel">
      {kind === 'commit' && (
        <>
          <CompareHint panel={panel} />
          <CommitDetails panel={panel} ratio={shown} />
          <SplitResizer ratio={shown} bounds={bounds} height={size.height} onChange={setRatio} onCommit={saveSplit} />
        </>
      )}
      {(kind === 'compare' || kind === 'compareWorktree') && <CompareHeader />}
      {kind === 'wip' && <WipHeader />}
      <FileSections panel={panel} />
    </div>
  );
}
