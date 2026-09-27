import { useEffect, useRef } from 'react';
import type { CommitDetailsPayload } from '../api/gen/CommitDetailsPayload';
import type { DiffSpec } from '../api/gen/DiffSpec';
import { copyText } from '../api/transport';
import { FileList } from '../files/FileList';
import { formatDate } from '../format/date';
import { perf } from '../perf';
import { useFocusZone } from '../repo/focus';
import { filesKey } from '../repo/services';
import { useRepoView, type FileSection } from '../repo/store';
import { useToast } from '../ui/toast';
import { Avatar } from '../avatars/Avatar';
import { LARGEST_AVATAR_PX } from '../avatars/avatarStore';
import { CoAuthors } from './CoAuthors';
import { CompareHeader } from './CompareHeader';
import { WipHeader } from './WipHeader';
import { Message, useProjectRemote } from './Message';
import { SignatureBadge } from './SignatureBadge';
import './details.css';

/** The commit header (spec §9.1): SHA, parents, signature, author, the committer when different,
 * and co-authors. */
function CommitHeader({ d }: { d: CommitDetailsPayload }) {
  const toast = useToast((s) => s.show);
  const selectById = useRepoView((s) => s.selectCommitById);
  const committerDiffers = d.committer.name !== d.author.name || d.committer.email !== d.author.email || d.committer.time !== d.author.time;
  return (
    <header className="commit-header">
      <div className="commit-ids">
        <button type="button" className="sha" data-testid="details-sha" title="Copy full SHA" onClick={() => copyText(d.id).then(() => toast('Copied'), () => toast('Copy failed'))}>
          {d.id.slice(0, 6)}
        </button>
        {d.parents.length > 0 && (
          <span className="parents">
            {d.parents.length > 1 ? 'parents' : 'parent'}
            {d.parents.map((p) => (
              <button key={p} type="button" className="sha" data-testid="parent-sha" title={p} onClick={() => { if (!selectById(p)) toast('Not in the loaded history'); }}>
                {p.slice(0, 6)}
              </button>
            ))}
          </span>
        )}
        <SignatureBadge id={d.id} signed={d.signed} />
      </div>
      <div className="person" data-testid="author">
        <Avatar name={d.author.name} email={d.author.email} size={LARGEST_AVATAR_PX} />
        <span className="person-name">{d.author.name}</span> <span className="dim">authored {formatDate(d.author.time)}</span>
      </div>
      {committerDiffers && (
        <div className="person" data-testid="committer">
          <Avatar name={d.committer.name} email={d.committer.email} size={20} />
          <span className="person-name">{d.committer.name}</span> <span className="dim">committed {formatDate(d.committer.time)}</span>
        </div>
      )}
      <CoAuthors coAuthors={d.coAuthors} />
    </header>
  );
}

/**
 * The selected commit: its header from `details`, its message (§9.2) from `message` (the shared
 * `commitMessage` cache; `CommitDetailsPayload` has no message). Until the message arrives, the
 * graph row's summary and first body line stand in (plain text), so fast Up/Down never flashes an
 * empty panel; the loaded message is linkified against the project remote, with `Open !n` buttons.
 */
function CommitDetails() {
  const details = useRepoView((s) => s.details);
  const message = useRepoView((s) => s.message);
  const row = useRepoView((s) => (s.selection.kind === 'commit' ? s.graph.rows[s.selection.index] : undefined));
  const remote = useProjectRemote(useRepoView((s) => s.services));
  const readyId = details.status === 'ready' && message.status === 'ready' ? details.data.id : null;
  useEffect(() => {
    if (readyId) perf.done('details');
  }, [readyId]);
  return (
    <div className="commit-details">
      {details.status === 'ready' && <CommitHeader d={details.data} />}
      {details.status === 'error' && <div role="alert" className="details-error">{details.message}</div>}
      {message.status === 'ready' ? <Message summary={message.data.summary} body={message.data.body} remote={remote} /> : (
        <h2 className="details-summary" data-testid="details-summary">{row?.summary ?? ''}</h2>
      )}
      {(message.status === 'loading' || message.status === 'idle') && row?.bodyFirstLine && (
        <div className="details-body" data-testid="details-body" aria-busy="true">{row.bodyFirstLine}</div>
      )}
      {message.status === 'error' && <div role="alert" className="details-error">{message.message}</div>}
    </div>
  );
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** The merge parent picker (spec §9.3): `vs 1st parent | vs 2nd parent`. */
function ParentPicker() {
  const selection = useRepoView((s) => s.selection.kind);
  const details = useRepoView((s) => s.details);
  const parent = useRepoView((s) => s.parent);
  const setParent = useRepoView((s) => s.setParent);
  if (selection !== 'commit' || details.status !== 'ready' || details.data.parents.length < 2) return null;
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
      ) : (
        <div className="file-section-status" aria-busy="true">Loading files…</div>
      )}
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

/** The file lists (spec §9.3): the `files` focus zone. A focus request that arrives before the
 * lists have loaded lands on the zone itself (or an empty list) and moves to the right list as
 * the lists appear. */
function FileSections() {
  const sections = useRepoView((s) => s.sections);
  const ref = useRef<HTMLDivElement>(null);
  const zone = useFocusZone('files', ref, pickFileList);
  const loaded = sections.map((s) => s.list.status).join();
  useEffect(() => {
    const el = ref.current;
    const active = document.activeElement;
    if (!el || !(active === el || (active instanceof HTMLElement && el.contains(active) && active.matches('[role="listbox"][data-empty]')))) return;
    const target = pickFileList(el);
    if (target && target !== active) target.focus({ preventScroll: true });
  }, [loaded]);
  return (
    <div ref={ref} className="file-sections" tabIndex={-1} {...zone}>
      <ParentPicker />
      {sections.map((s) => <FileSectionView key={filesKey(s.spec)} section={s} />)}
    </div>
  );
}

/** Shown while the first Ctrl+click of a compare waits for the second (spec §9.4). */
function CompareHint() {
  const pending = useRepoView((s) => s.marks.a !== null && s.marks.b === null && s.selection.kind === 'commit');
  return pending ? <div className="compare-hint">Ctrl+click another commit to compare</div> : null;
}

/** The right panel: a commit's details, a compare's header, or the read-only WIP header, each
 * above the file lists (spec §9). */
export function DetailsPanel() {
  const kind = useRepoView((s) => s.selection.kind);
  return (
    <div className="details-panel">
      {kind === 'commit' && <><CompareHint /><CommitDetails /></>}
      {(kind === 'compare' || kind === 'compareWorktree') && <CompareHeader />}
      {kind === 'wip' && <WipHeader />}
      {kind !== 'none' && <FileSections />}
    </div>
  );
}
