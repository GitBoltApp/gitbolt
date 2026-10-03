import { useEffect, useLayoutEffect, useMemo, useReducer, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api/client';
import type { BlamePayload } from '../api/gen/BlamePayload';
import type { FileHistoryRow } from '../api/gen/FileHistoryRow';
import { Avatar } from '../avatars/Avatar';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import type { FileMargin, MonacoHost } from '../diff/monaco/host';
import { useMonacoHost } from '../diff/TextDiff';
import type { DateFormat } from '../api/gen/DateFormat';
import { useAppState } from '../app/state';
import { formatDate } from '../format/date';
import { compactRelativeTime, relativeTime } from '../format/relative';
import { shortSha } from '../format/sha';
import type { Loadable } from '../repo/store';
import { useTheme } from '../theme/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { colorIndex, groupBlame, visibleGroups } from './blame';

/** The strip's width (ruling 8; UX round 1: 200 px), at most BLAME_MARGIN_SHARE of the editor's,
 * so the code keeps most of a narrow editor. */
export const BLAME_MARGIN_PX = 200;
export const BLAME_MARGIN_SHARE = 0.35;
const BLAME_CACHE = 32;
const AVATAR_PX = 16;

const loaders = new Map<string, Loader<BlamePayload>>();
/** Blame per (rev, path), cached per repo and worktree (spec #3 §3.10). */
function blameLoader(repoId: number, worktree: string): Loader<BlamePayload> {
  const k = `${repoId}\0${worktree}`;
  let l = loaders.get(k);
  if (!l) {
    l = new Loader((key) => {
      const [rev, path] = key.split('\0');
      return api.blame(repoId, worktree, rev, path);
    }, new Lru(BLAME_CACHE), 2);
    loaders.set(k, l);
  }
  return l;
}

export function useBlame(repoId: number, worktree: string, rev: string, path: string): Loadable<BlamePayload> {
  const loader = blameLoader(repoId, worktree);
  const key = `${rev}\0${path}`;
  const [state, setState] = useState<{ key: string; value: Loadable<BlamePayload> }>({ key: '', value: { status: 'idle' } });
  useEffect(() => {
    let live = true;
    const hit = loader.peek(key);
    if (hit) {
      setState({ key, value: { status: 'ready', data: hit } });
      return;
    }
    setState({ key, value: { status: 'loading' } });
    loader.get(key).then(
      (data) => { if (live) setState({ key, value: { status: 'ready', data } }); },
      (e: unknown) => { if (live) setState({ key, value: { status: 'error', message: errorMessage(e) } }); },
    );
    return () => { live = false; };
  }, [loader, key]);
  if (state.key === key) return state.value;
  const hit = loader.peek(key);
  return hit ? { status: 'ready', data: hit } : { status: 'loading' };
}

/** The gutter for `row`'s file (its own path at its commit). No layout shift: the strip stays
 * reserved while Blame is on, whatever the load state; it's empty (busy) while `row`'s blame
 * loads, never the previous commit's rows, and a failure is a note over the editor's corner. */
export function BlameLayer({ repoId, worktree, row, onPick }: { repoId: number; worktree: string; row: FileHistoryRow; onPick(sha: string, inGraph: boolean): void }) {
  const { host } = useMonacoHost();
  const blame = useBlame(repoId, worktree, row.sha, row.path);
  return (
    <>
      {host && <BlameGutter host={host} blame={blame.status === 'ready' ? blame.data : null} onPick={onPick} />}
      {blame.status === 'error' && <div className="blame-note" role="alert">Couldn't load the blame: {blame.message}</div>}
    </>
  );
}

/**
 * Blame (spec #3 §3.10, §4.2): per line group, a colour bar, the author's avatar, the summary and
 * the date, in the file editor's margin strip left of the line numbers (`host.setFileMargin`), on
 * the code's line box, redrawn as it scrolls. A
 * click picks the group's commit (`onPick(sha, false)`); Alt+click picks it in the graph. The strip
 * is reserved while it's mounted; `blame` null (loading) draws it empty.
 */
export function BlameGutter({ host, blame, onPick }: { host: MonacoHost; blame: BlamePayload | null; onPick(sha: string, inGraph: boolean): void }) {
  const [margin, setMargin] = useState<FileMargin | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    setMargin(host.setFileMargin(BLAME_MARGIN_PX, BLAME_MARGIN_SHARE));
    return () => { host.setFileMargin(0); };
  }, [host]);
  useEffect(() => margin?.onChange(redraw), [margin]);
  const groups = useMemo(() => (blame ? groupBlame(blame.hunks) : []), [blame]);
  const commits = useMemo(() => new Map((blame?.commits ?? []).map((c) => [c.sha, c])), [blame]);
  const palette = useTheme((s) => s.colors.graph);
  const dateFormat = useAppState((s) => s.settings.dateFormat);
  if (!margin) return null;
  const { first, last } = margin.visibleLines();
  // Monaco's own line box and font size (UX B.3): a group's first row is one code line high, its
  // text centred in it as the code's is, so blame text, avatar and code share a baseline.
  const { lineHeight, fontSize } = margin.metrics();
  return createPortal(
    <div className="blame-gutter" data-testid="blame-gutter" aria-busy={blame === null} style={{ '--blame-line': `${lineHeight}px`, '--blame-font': `${fontSize}px` } as CSSProperties}>
      {visibleGroups(groups, first, last).map((g) => {
        const c = commits.get(g.sha);
        const top = margin.lineTop(g.start);
        const height = margin.lineBottom(g.start + g.lines - 1) - top;
        return (
          // The strip ellipsizes the summary: the whole of it, and the date, show on hover.
          <HoverTooltip key={`${g.sha}:${g.start}`} placement="pointer" disabled={!c} content={c && <BlameTip summary={c.summary} author={c.author} time={c.time} dateFormat={dateFormat} />}>
          <button
            type="button"
            className="blame-group"
            data-testid="blame-group"
            data-line={g.start}
            style={{ top, height }}
            aria-label={`${c?.summary ?? shortSha(g.sha)} by ${c?.author ?? 'unknown'}: show this commit (Alt+click: in the graph)`}
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={(e) => onPick(g.sha, e.altKey)}
          >
            <span className="blame-bar" style={{ background: palette[colorIndex(g.sha, palette.length)] }} />
            <span className="blame-line">
              {c && <Avatar name={c.author} email={c.email} size={Math.min(AVATAR_PX, lineHeight - 2)} />}
              <span className="blame-summary">{c?.summary}</span>
              <span className="blame-date">{c ? compactRelativeTime(c.time) : ''}</span>
            </span>
          </button>
          </HoverTooltip>
        );
      })}
    </div>,
    margin.node,
  );
}

function BlameTip({ summary, author, time, dateFormat }: { summary: string; author: string; time: number; dateFormat: DateFormat }) {
  return (
    <div className="blame-tip">
      <div>{summary}</div>
      <div className="blame-tip-meta">{author} · {relativeTime(time)} · {formatDate(time, dateFormat)}</div>
    </div>
  );
}
