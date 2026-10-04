import type { TagAnnotation } from '../api/gen/TagAnnotation';
import { useAppState } from '../app/state';
import { formatDate } from '../format/date';
import { shortSha } from '../format/sha';
import './tags.css';

/**
 * A tag's tooltip (UX round 3, M.2), on its graph chip and in its sidebar hover card: an annotated
 * tag's message (its first lines, from the refs payload: no request per hover), then its tagger
 * and date; a lightweight tag's "Lightweight tag" and the commit it names.
 */
export function TagTip({ annotation, sha }: { annotation?: TagAnnotation | null; sha: string | null }) {
  const dateFormat = useAppState((s) => s.settings.dateFormat);
  if (!annotation) {
    return (
      <div className="tag-tip">
        <div>Lightweight tag</div>
        {sha && <div className="tag-tip-meta">{shortSha(sha)}</div>}
      </div>
    );
  }
  const by = [annotation.tagger, annotation.time > 0 ? formatDate(annotation.time, dateFormat) : null].filter(Boolean).join(' · ');
  return (
    <div className="tag-tip">
      {annotation.message && <div className="tag-tip-message">{annotation.message}{annotation.truncated && '\n…'}</div>}
      {by && <div className="tag-tip-meta">{by}</div>}
    </div>
  );
}
