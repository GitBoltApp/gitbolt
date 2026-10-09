import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Review M7: tooltips are the app's instant HoverTooltip, never the native `title` (whose OS
// delay breaks the app-wide "tooltips show immediately" rule). The resize handles' `title` is the
// one known holdout (ColumnResizer, PanelResizer: they sit on a 4 px strip under the pointer).
const FILES = [
  'diff/DiffPanel.tsx',
  'details/CompareHeader.tsx',
  'details/MultiSummary.tsx',
  'details/WipHeader.tsx',
  'files/FileList.tsx',
  'details/DetailsPanel.tsx',
  'graph/GraphView.tsx',
  'tags/TagNameInput.tsx',
  'history/FileHistory.tsx',
  'history/BlameGutter.tsx',
  'history/HistoryButtons.tsx',
  'irebase/RebaseEditor.tsx',
  'irebase/ChipColumn.tsx',
  'diff/review/CommentBox.tsx',
  'diff/monaco/reviewGutter.ts',
];

describe('no native title tooltips', () => {
  it.each(FILES)('%s sets no title attribute on an element', (file) => {
    const src = readFileSync(join(__dirname, file), 'utf8');
    // `title=` as a JSX attribute on a DOM element; component props (HeaderCell's `title="GRAPH"`,
    // EditorLoadError's `title`) start with an uppercase tag.
    const hits = [...src.matchAll(/<([a-z][\w-]*)\b[^<>]*?\stitle=/g)].map((m) => m[0].slice(0, 60));
    // Built in the DOM (Monaco's overlay widgets): `el.title = …` or `setAttribute('title', …)`.
    const dom = [...src.matchAll(/\.title\s*=(?!=)|setAttribute\(\s*['"]title['"]/g)].map((m) => m[0]);
    expect([...hits, ...dom]).toEqual([]);
  });
});
