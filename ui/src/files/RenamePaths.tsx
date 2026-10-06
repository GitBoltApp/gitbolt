import { formatChange, renameHighlight, type HighlightParts } from './renameParts';
import './renamePaths.css';

/** One path of a rename: what both paths share dimmed, what changed highlighted (J15). Empty
 * parts render nothing. */
function PathLine({ parts }: { parts: HighlightParts }) {
  const [pre, changed, suf] = parts;
  return (
    <div className="rename-path">
      {pre && <span className="rename-common">{pre}</span>}
      {changed && <span className="rename-changed">{changed}</span>}
      {suf && <span className="rename-common">{suf}</span>}
    </div>
  );
}

/**
 * A rename's paths for a tooltip (feedback H21, H22): three left-aligned lines, the old full
 * path, a down arrow centred between them, the new full path. On both paths, the parts they share
 * are dimmed so only what changed stands out (J15, `renameHighlight`). An image converted to
 * another format says so under them ("Format changed: PNG → WebP"). Shared by the file list's
 * row tooltip and the diff header's.
 */
export function RenamePaths({ oldPath, path }: { oldPath: string; path: string }) {
  const h = renameHighlight(oldPath, path);
  const format = formatChange(oldPath, path);
  return (
    <div className="rename-paths" data-testid="rename-paths">
      <PathLine parts={h.old} />
      <div className="rename-arrow" role="img" aria-label="renamed to">↓</div>
      <PathLine parts={h.new} />
      {format && <div className="rename-format" data-testid="format-change">Format changed: {format}</div>}
    </div>
  );
}

/** A file's full path, or (a rename) its old and new paths stacked. */
export function PathTooltip({ path, oldPath }: { path: string; oldPath: string | null }) {
  return oldPath ? <RenamePaths oldPath={oldPath} path={path} /> : <span className="path-tooltip">{path}</span>;
}
