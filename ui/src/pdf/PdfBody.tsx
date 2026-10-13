import { useMemo } from 'react';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { HexDumpPayload } from '../api/gen/HexDumpPayload';
import { HexBody } from '../diff/hex';
import type { DiffTarget } from '../repo/store';
import { PdfView, type PdfSource } from './PdfView';

const sourceOf = (b: BlobPayload | null): PdfSource | null => (b?.base64 != null ? { base64: b.base64, size: b.size } : null);

/**
 * A PDF's pages: File View shows the file at that revision (the new side, or the old one if it was
 * deleted); Diff View shows both versions side by side, or the one an added or deleted PDF has.
 * Its Hex toggle shows the hex dump, as a raster image's does. `contents` is the loader's cached
 * object, so the sides (and so the opened documents) hold across re-renders.
 */
export function PdfBody({ target, contents: c, onSourceChange, onHex }: { target: DiffTarget; contents: DiffContentsPayload; onSourceChange?: (on: boolean) => void; onHex?: (key: string, hex: HexDumpPayload) => void }) {
  const fileView = target.view === 'file';
  const old = useMemo(() => (fileView && c.new ? null : sourceOf(c.old)), [c, fileView]);
  const neu = useMemo(() => (fileView && !c.new ? null : sourceOf(c.new)), [c, fileView]);
  const single = fileView ? null : !c.old ? 'added' : !c.new ? 'deleted' : null;
  const hex = <HexBody target={target} contents={c} onLoaded={(h) => onHex?.(target.key, h)} />;
  return <PdfView key={target.key} old={old} new={neu} single={single} source={hex} onSourceChange={onSourceChange} />;
}
