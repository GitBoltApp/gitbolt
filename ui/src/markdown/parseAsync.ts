import type { Root } from 'mdast';
import { HAS_SHORTCODE, loadEmoji } from '../forge/emoji';
import { splitChunks } from './chunks';
import { diffChunks } from './diff/diffChunks';
import { whenIdle } from './idle';
import { textKey } from '../util/textHash';
import { SYNC_PARSE_CHARS } from './limits';
import { parseMarkdown } from './parse';
import type { ParseReply, ParseRequest } from './parse.worker';
import type { MdFlavor } from './types';

/** A large document's chunks as they arrive (ruling 21). */
export interface ChunkStream {
  readonly chunks: Root[];
  readonly done: boolean;
  readonly failed: boolean;
  /** Failed because only the main thread was left to parse it, and it's too long for that (the
   * worker died), or (5C) a diff whose alignment gave up: the body shows as written, "Too large to
   * render". */
  readonly tooLarge: boolean;
  /** Bumped on every change (a `useSyncExternalStore` snapshot). */
  readonly version: number;
  subscribe(fn: () => void): () => void;
}

class Stream implements ChunkStream {
  chunks: Root[] = [];
  done = false;
  failed = false;
  tooLarge = false;
  version = 0;
  private fns = new Set<() => void>();
  readonly key: string;
  readonly text: string;
  readonly flavor: MdFlavor;
  /** A diff's old text (5C); `null` for a plain parse. */
  readonly old: string | null;
  constructor(key: string, text: string, flavor: MdFlavor, old: string | null = null) {
    this.key = key;
    this.text = text;
    this.flavor = flavor;
    this.old = old;
  }
  get watched(): boolean { return this.fns.size > 0; }
  /** The last subscriber leaving a parse still going abandons it, unless one comes back within
   * the task (a re-subscribe: React's effects re-running). */
  subscribe = (fn: () => void) => {
    this.fns.add(fn);
    return () => {
      this.fns.delete(fn);
      if (this.fns.size === 0 && !this.done) setTimeout(() => abandon(this), 0);
    };
  };
  private changed() { this.version++; for (const f of this.fns) f(); }
  push(chunks: Root[], done: boolean) { this.chunks.push(...chunks); this.done = done; this.changed(); }
  replace(chunks: Root[]) { this.chunks = chunks; this.done = true; this.changed(); }
  fail(tooLarge = false) { this.failed = true; this.tooLarge = tooLarge; this.done = true; this.changed(); }
}

/** A stream's chunks, worked out on the main thread: a parse, or (5C) a diff. `null`: the diff's
 * alignment gave up. */
const chunksOf = (s: Stream): Root[] | null => (s.old === null ? splitChunks(parseMarkdown(s.text, s.flavor)) : diffChunks(s.old, s.text, s.flavor));
const sourceChars = (s: Stream) => s.text.length + (s.old?.length ?? 0);

/** Large texts are kept with their chunks: a poll or a reopened view renders without parsing. */
const STREAMS_KEPT = 8;
const streams = new Map<string, Stream>();
const inFlight = new Map<number, Stream>();
let worker: Worker | null | undefined; // undefined: not tried yet; null: none (jsdom, or it died)
let workerDied = false;
let nextId = 0;

/** The parse on the main thread, in one idle callback: no Worker (jsdom). Once the worker has
 * died, a text over SYNC_PARSE_CHARS would freeze the app for its whole parse: it fails as too
 * large instead (shown as written). */
function onMainThread(s: Stream): void {
  if (workerDied && sourceChars(s) > SYNC_PARSE_CHARS) {
    s.fail(true);
    return;
  }
  whenIdle(() => {
    void (async () => {
      try {
        if (HAS_SHORTCODE.test(s.text) || (s.old !== null && HAS_SHORTCODE.test(s.old))) await loadEmoji().catch(() => {});
        const chunks = chunksOf(s);
        if (chunks) s.replace(chunks);
        else s.fail(true);
      } catch {
        s.fail();
      }
    })();
  });
}

function theWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = typeof Worker === 'function' ? new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' }) : null;
  } catch {
    worker = null;
  }
  if (worker) {
    worker.onmessage = (e: MessageEvent<ParseReply>) => {
      const r = e.data;
      const s = inFlight.get(r.id);
      if (!s) return;
      if ('error' in r) { inFlight.delete(r.id); s.fail(r.tooLarge === true); return; }
      if (r.last) inFlight.delete(r.id);
      s.push([r.chunk], r.last);
    };
    worker.onerror = () => {
      const pending = [...inFlight.values()];
      inFlight.clear();
      worker?.terminate();
      worker = null;
      workerDied = true;
      pending.forEach(onMainThread);
    };
  }
  return worker;
}

function post(w: Worker, s: Stream): void {
  const id = ++nextId;
  inFlight.set(id, s);
  w.postMessage((s.old === null ? { id, text: s.text, flavor: s.flavor } : { id, kind: 'diff', old: s.old, text: s.text, flavor: s.flavor }) satisfies ParseRequest);
}

/**
 * A parse nobody waits for any more (File View fell back to Source at 2 s, or the view left the
 * document mid-parse): it leaves the cache, so its partial result is never served, and its worker
 * is terminated, so later parses don't queue behind it for seconds. The parses queued behind it
 * start again on a fresh worker (from their first chunk). A main-thread parse can't be stopped.
 */
function abandon(s: Stream): void {
  if (s.done || s.watched) return;
  if (streams.get(s.key) === s) streams.delete(s.key);
  const mine = [...inFlight].some(([, x]) => x === s);
  s.fail();
  if (!mine || !worker) return;
  const others = [...new Set([...inFlight.values()].filter((x) => x !== s))];
  inFlight.clear(); // the old ids: anything the old worker still sends is dropped
  worker.terminate();
  worker = undefined;
  const fresh = theWorker();
  if (!fresh) workerDied = true; // no new worker: the queued parses mustn't freeze the main thread either
  for (const o of others) {
    o.chunks = [];
    if (fresh) post(fresh, o);
    else onMainThread(o);
  }
}

function streamFor(key: string, make: () => Stream): ChunkStream {
  const hit = streams.get(key);
  if (hit && !hit.failed) {
    streams.delete(key);
    streams.set(key, hit);
    return hit;
  }
  const s = make();
  streams.set(key, s);
  if (streams.size > STREAMS_KEPT) streams.delete(streams.keys().next().value!);
  const w = theWorker();
  if (w) post(w, s);
  else onMainThread(s);
  return s;
}

/** `text`'s chunks, parsed off the main thread; one stream per text, kept for the session's
 * recent large documents. Streams are keyed by a hash of their texts (`textKey`), never the texts
 * themselves: a key that concatenates them would copy megabytes. */
export function chunkStream(text: string, flavor: MdFlavor): ChunkStream {
  const key = `${flavor}\0${textKey(text)}`;
  return streamFor(key, () => new Stream(key, text, flavor));
}

/** 5C: the rendered diff of `old` → `neu` as chunks (the first carries `gbChanges`), aligned and
 * word-diffed off the main thread; one stream per pair, kept like a large document. A diff whose
 * alignment gave up fails as `tooLarge`. */
export function diffChunkStream(old: string, neu: string, flavor: MdFlavor): ChunkStream {
  const key = `diff\0${flavor}\0${textKey(old)}\0${textKey(neu)}`;
  return streamFor(key, () => new Stream(key, neu, flavor, old));
}

/** Tests. */
export function resetChunkStreams(): void {
  streams.clear();
  inFlight.clear();
  worker?.terminate();
  worker = undefined;
  workerDied = false;
}
