// File History's Changes (with FileHistory.tsx, in its lazy chunk): the diff the selected commit
// made to the file, in Diff View's own body and toolbar.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '../api/client';
import type { FileChange } from '../api/gen/FileChange';
import type { FileHistoryRow } from '../api/gen/FileHistoryRow';
import { useChangeKeys } from '../diff/changeKeys';
import { FORCED_CEILING_LABEL, ImageBody, isHex, isImage, useContents, usePresented } from '../diff/DiffPanel';
import { DiffTextBody } from '../diff/DiffTextBody';
import { DiffToolbar } from '../diff/DiffToolbar';
import { MarkdownViewToggle } from '../diff/FileBody';
import { formatBytes } from '../diff/format';
import { HexBody, HexView } from '../diff/hex';
import { hexOf } from '../diff/hexContents';
import { highlightLanguage } from '../diff/language';
import { isMarkdownTarget, TOO_LARGE_TO_RENDER, useDiffTooLarge } from '../diff/markdownFiles';
import { useMarkdownView } from '../diff/markdownOverride';
import { filesKey, type RepoServices } from '../repo/services';
import { useRepoView } from '../repo/store';
import { ArrowGlyph } from '../ui/ArrowGlyph';
import { changesSpec, changesTarget, needsFileList, type ChangesTarget } from './changes';

/** A commit's file list (immutable, so cached): `undefined` while it loads, `null` if it failed
 * or there's none to load (`key` null). */
function useFileList(services: RepoServices, key: string | null): readonly FileChange[] | null | undefined {
  const [state, setState] = useState<{ key: string | null; files: readonly FileChange[] | null }>({ key: null, files: null });
  useEffect(() => {
    if (key === null || services.files.peek(key)) return;
    let live = true;
    services.files.get(key).then(
      (list) => { if (live) setState({ key, files: list.files }); },
      (e: unknown) => {
        if (!live) return;
        console.warn(`file history: couldn't list the commit's files: ${errorMessage(e)}`);
        setState({ key, files: null });
      },
    );
    return () => { live = false; };
  }, [services, key]);
  if (key === null) return null;
  const hit = services.files.peek(key);
  if (hit) return hit.files;
  return state.key === key ? state.files : undefined;
}

/**
 * Changes (the `File | Changes` switch's second view): the selected row's commit against the
 * previous version in the file's history (`changesTarget`), with Diff View's toolbar (`views` in
 * File View / Diff View's place) and body: the view modes, whitespace, wrap, Previous/Next change
 * and F7, a Markdown file's `Source | Rendered` (Rendered by default, 5C), the image diff and the
 * hex diff. The row's target keeps the shared editor from file to file, as in Diff View: while
 * the next one loads, the last one stays (`usePresented`).
 */
export function ChangesAtCommit({ row, views }: { row: FileHistoryRow; views: ReactNode }) {
  const services = useRepoView((s) => s.services);
  const files = useFileList(services, needsFileList(row) ? filesKey(changesSpec(row)) : null);
  const next = useMemo(() => changesTarget(row, files), [row, files]);
  // A rename's file list loading: the last row's diff stays until it's in.
  const last = useRef<ChangesTarget | null>(null);
  if (next) last.current = next;
  const target = next ?? last.current;
  if (!target) {
    return (
      <>
        <DiffToolbar target={{ ...emptyTarget, path: row.path }} canDiff canStep={false} views={views} />
        <div className="diff-body"><div className="diff-message" aria-busy="true">Loading…</div></div>
      </>
    );
  }
  return <ChangesBody target={target} views={views} />;
}

const emptyTarget: ChangesTarget = { key: '', path: '', oldPath: null, status: '', old: { kind: 'absent' }, new: { kind: 'absent' }, view: 'diff', sides: { old: null, new: null } };

function ChangesBody({ target, views }: { target: ChangesTarget; views: ReactNode }) {
  const services = useRepoView((s) => s.services);
  // "Load anyway" holds for the file it was pressed on; another row asks again.
  const [forcedKey, setForcedKey] = useState<string | null>(null);
  const live = useContents(services, target, forcedKey === target.key);
  const body = usePresented(target, live);
  const shown = body.target as ChangesTarget;
  const contents = body.contents;
  const loaded = contents.status === 'ready' ? contents.data : null;
  const textBody = !!loaded && !loaded.tooLarge && !isImage(shown, loaded) && !isHex(shown, loaded);
  const mdDiff = textBody && isMarkdownTarget(shown);
  const diffTooLarge = useDiffTooLarge(shown.key, mdDiff ? loaded?.old?.text ?? '' : '', mdDiff ? loaded?.new?.text ?? '' : '').tooLarge;
  const picked = useMarkdownView(mdDiff ? shown.path : null);
  const rendered = mdDiff && picked === 'rendered' && !diffTooLarge;
  // An SVG's Source toggle (or a raster image's Hex), per file: a text (or hex) diff to step through.
  const [sourceOf, setSourceOf] = useState<string | null>(null);
  const imageDiff = !!loaded && !loaded.tooLarge && isImage(shown, loaded);
  const svgSource = imageDiff && sourceOf === shown.key;
  const textDiff = (!!loaded && !loaded.tooLarge && !imageDiff) || svgSource;
  const hexImage = svgSource && !shown.path.toLowerCase().endsWith('.svg');
  useChangeKeys(textDiff);
  return (
    <>
      <DiffToolbar
        target={shown}
        canDiff
        canStep={textDiff}
        textTools={!imageDiff || svgSource}
        binary={!!loaded && (isHex(shown, loaded) || hexImage)}
        rendered={rendered}
        views={views}
        markdown={mdDiff ? <MarkdownViewToggle path={shown.path} forced={diffTooLarge ? TOO_LARGE_TO_RENDER : null} /> : null}
      />
      <div className="diff-body" data-testid="history-changes">
        <Body target={shown} contents={contents} forced={forcedKey === shown.key} onLoadAnyway={() => setForcedKey(shown.key)} onSourceChange={(on) => setSourceOf(on ? shown.key : null)} />
      </div>
    </>
  );
}

/** Diff View's `Body` for a history row: no working copy, no hunk actions; the Markdown sides
 * are the row's commit and its parent. */
function Body({ target, contents, forced, onLoadAnyway, onSourceChange }: { target: ChangesTarget; contents: ReturnType<typeof useContents>; forced: boolean; onLoadAnyway: () => void; onSourceChange: (on: boolean) => void }) {
  if (contents.status === 'error') return <div role="alert" className="diff-message">{contents.message}</div>;
  if (contents.status !== 'ready') return <div className="diff-message" aria-busy="true">Loading…</div>;
  const c = contents.data;
  if (c.tooLarge) {
    return (
      <div className="diff-message">
        <p>{forced ? `Too large to show — over ${FORCED_CEILING_LABEL} per side` : 'Large file — load anyway?'}</p>
        <p className="dim">{formatBytes(c.old?.size)} <ArrowGlyph /> {formatBytes(c.new?.size)}</p>
        {!forced && <button type="button" className="text-button" onClick={onLoadAnyway}>Load anyway</button>}
      </div>
    );
  }
  if (isImage(target, c)) return <ImageBody target={target} contents={c} onSourceChange={onSourceChange} />;
  if (isHex(target, c)) {
    const hex = hexOf(c);
    return hex ? <HexView path={target.path} hex={hex} file={false} /> : <HexBody target={target} contents={c} />;
  }
  const original = c.old?.text ?? '';
  const modified = c.new?.text ?? '';
  return (
    <DiffTextBody
      identity={target.key} path={target.path} oldPath={target.oldPath} original={original} modified={modified}
      language={highlightLanguage(target.path, modified || original)}
      markdown={isMarkdownTarget(target) ? target.sides : null}
    />
  );
}
