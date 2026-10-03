// Binary files in a hex view (phase 3 UX round 2, lanes I and K): hex | text, each a read-only
// Monaco editor of its own (monaco/hexPanes.ts), scrolled together. File View shows one side's
// bytes; Diff View both sides' side by side, byte i against byte i, the changed bytes coloured in
// both panes (an added or deleted file: its one side, all of it). The core makes the dumps
// (`hexDump`, hex.rs), each capped (`HexDumpPayload.cap`); the bytes are read back from them
// (hexModel.ts). A binary's load with its contents (hexContents.ts); `HexBody` loads them itself
// (an image's Hex toggle).
import { ArrowRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { HexDumpPayload } from '../api/gen/HexDumpPayload';
import type { HexSide } from '../api/gen/HexSide';
import { useRepoContext } from '../app/repoContext';
import { contentKey, isMutableKey } from '../repo/services';
import { contentsRequest, type DiffTarget } from '../repo/store';
import type { HexView as HexViewApi } from './monaco/host';
import { EditorLoadError, useMonacoHost, useOnShown } from './TextDiff';
import './hex.css';

/** One decimal, none when it's 0: "1.2", "256". */
const decimal = (x: number) => x.toFixed(1).replace(/\.0$/, '');

/** "1 byte", "6 bytes", "1.2 KB", "256 KB", "4.2 MB". */
export function formatSize(n: number): string {
  if (n < 1024) return n === 1 ? '1 byte' : `${n} bytes`;
  if (n < 1024 * 1024) return `${decimal(n / 1024)} KB`;
  return `${decimal(n / (1024 * 1024))} MB`;
}

/** "1.2 KB → 1.3 KB", the arrow at text size (the UI font's own → is tiny). */
export function SizeChange({ old, new: neu }: { old: number; new: number }) {
  // The glyph stays in the text (copy, screen readers); the icon is what shows.
  return <>{formatSize(old)} <span className="size-arrow"><ArrowRight size={13} strokeWidth={1.75} aria-hidden="true" /><span className="size-arrow-text">→</span></span> {formatSize(neu)}</>;
}

/** Both sides' sizes, or the one there is, labelled "(added)" / "(deleted)". */
function SidesSize({ c }: { c: DiffContentsPayload }) {
  if (c.old && c.new) return <SizeChange old={c.old.size} new={c.new.size} />;
  const side = c.new ?? c.old;
  return side ? <>{formatSize(side.size)} ({c.new ? 'added' : 'deleted'})</> : null;
}

/** What the file bar says about a binary: "Binary · 6 bytes (added)", "Binary · 1.2 KB → 1.3 KB"
 * (File View: the shown revision's size only). When a shown dump stops short of its side (`hex`,
 * once loaded), a second note: "Showing the first 256 KB of 4.2 MB". `summary` false: the note
 * only (an image's Hex view). */
export function BinaryNote({ target, contents: c, hex, summary = true }: { target: DiffTarget; contents: DiffContentsPayload; hex: HexDumpPayload | null; summary?: boolean }) {
  const file = target.view === 'file';
  const shown = !hex ? [] : file ? [c.new ? hex.new : hex.old] : [hex.old, hex.new];
  const over = shown.filter((s): s is HexSide => !!s && s.shown < s.size).map((s) => s.size);
  const cap = hex ? formatSize(hex.cap) : '';
  return (
    <>
      {summary && (
        <span className="binary-summary" data-testid="binary-summary">
          Binary · {file ? formatSize((c.new ?? c.old)?.size ?? 0) : <SidesSize c={c} />}
        </span>
      )}
      {over.length > 0 && (
        <span className="hex-capped" data-testid="hex-capped">
          {over.length === 1 ? `Showing the first ${cap} of ${formatSize(over[0])}` : `Showing the first ${cap} of each side`}
        </span>
      )}
    </>
  );
}

/** Recent dumps of stored versions (object ids: they never change); a working-tree side is read
 * again with each new contents payload. */
const cache = new Map<string, Promise<HexDumpPayload>>();
const CACHE_ENTRIES = 16;

function loadHex(repo: number, target: DiffTarget): Promise<HexDumpPayload> {
  const req = contentsRequest(target);
  const key = `${repo}|${contentKey(req)}`;
  if (isMutableKey(key)) return api.hexDump(repo, req);
  let hit = cache.get(key);
  if (hit) {
    cache.delete(key);
  } else {
    hit = api.hexDump(repo, req);
    hit.catch(() => cache.delete(key));
  }
  cache.set(key, hit);
  for (const k of cache.keys()) if (cache.size > CACHE_ENTRIES) cache.delete(k);
  return hit;
}

type HexState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; key: string; data: HexDumpPayload };

/**
 * A binary's hex view (lane K): File View, `side`'s bytes; Diff View, both sides' (`hex`), side by
 * side. Shown in the commit that renders it (a layout effect, painted in that task), so the
 * panel's header and this body switch together: the panel doesn't wait for it (`onShown` still
 * fires, once it's shown or the editor failed to load).
 */
export function HexView({ path, hex, file, side, onShown }: { path: string; hex: HexDumpPayload; file: boolean; side?: HexSide | null; onShown?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { host, error, retry } = useMonacoHost();
  const shown = useOnShown(onShown, error);
  const view = useRef<HexViewApi | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!host || !el) return;
    const v = host.hexView(el);
    view.current = v;
    return () => {
      v.dispose();
      if (view.current === v) view.current = null;
    };
  }, [host]);
  useLayoutEffect(() => {
    if (!view.current) return;
    view.current.show(file ? { path, file, old: null, new: side ?? null } : { path, file, old: hex.old, new: hex.new });
    // Out of the effect: the callback may flush a render (DiffPanel's `flushSync`).
    const report = shown.current;
    queueMicrotask(() => report?.());
  }, [host, path, hex, file, side]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <EditorLoadError message={error} onRetry={retry} />;
  return <div ref={ref} className="hex-view" data-testid="hex-view" data-mode={file ? 'file' : 'diff'} />;
}

/** File View's side of a binary: the new one, else (a deleted file) the old one. */
export const fileSideOf = (c: DiffContentsPayload, d: HexDumpPayload): HexSide | null => (c.new ? d.new : d.old) ?? d.new ?? d.old;

/**
 * A binary's hex view, loading its dumps itself. While the next file's dumps load, the previous
 * ones stay on screen; `onShown` fires once this file's are on screen, or its load failed.
 * `onLoaded`: the dumps, for the file bar's note.
 */
export function HexBody({ target, contents, onShown, onLoaded }: { target: DiffTarget; contents: DiffContentsPayload; onShown?: () => void; onLoaded?: (hex: HexDumpPayload) => void }) {
  const { repoId } = useRepoContext();
  const [state, setState] = useState<HexState>({ status: 'loading' });
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  useEffect(() => {
    let live = true;
    loadHex(repoId, target).then(
      (data) => {
        if (!live) return;
        setState({ status: 'ready', key: target.key, data });
        loaded.current?.(data);
      },
      (e: unknown) => { if (live) setState({ status: 'error', message: errorMessage(e) }); },
    );
    return () => { live = false; };
    // `contents`: a new payload (a reload, a WIP change) reads a working-tree side again.
  }, [repoId, target.key, contents]); // eslint-disable-line react-hooks/exhaustive-deps
  useOnShown(onShown, state.status === 'error' ? state.message : null);
  if (state.status === 'error') return <div role="alert" className="diff-message">{state.message}</div>;
  if (state.status === 'loading') return <div className="diff-message" aria-busy="true">Loading…</div>;
  const d = state.data;
  // The previous file's dumps until this one's arrive: not reported as shown.
  const shown = state.key === target.key ? onShown : undefined;
  const file = target.view === 'file';
  return <HexView path={target.path} hex={d} file={file} side={file ? fileSideOf(contents, d) : undefined} onShown={shown} />;
}
