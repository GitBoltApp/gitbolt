import type { Root } from 'mdast';
import { HAS_SHORTCODE, loadEmoji } from '../forge/emoji';
import { splitChunks } from './chunks';
import { whenIdle } from './idle';
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
   * worker died): the body shows as written, "Too large to render". */
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
  readonly text: string;
  readonly flavor: MdFlavor;
  constructor(text: string, flavor: MdFlavor) {
    this.text = text;
    this.flavor = flavor;
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
  if (workerDied && s.text.length > SYNC_PARSE_CHARS) {
    s.fail(true);
    return;
  }
  whenIdle(() => {
    void (async () => {
      try {
        if (HAS_SHORTCODE.test(s.text)) await loadEmoji().catch(() => {});
        s.replace(splitChunks(parseMarkdown(s.text, s.flavor)));
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
      if ('error' in r) { inFlight.delete(r.id); s.fail(); return; }
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
  w.postMessage({ id, text: s.text, flavor: s.flavor } satisfies ParseRequest);
}

/**
 * A parse nobody waits for any more (File View fell back to Source at 2 s, or the view left the
 * document mid-parse): it leaves the cache, so its partial result is never served, and its worker
 * is terminated, so later parses don't queue behind it for seconds. The parses queued behind it
 * start again on a fresh worker (from their first chunk). A main-thread parse can't be stopped.
 */
function abandon(s: Stream): void {
  if (s.done || s.watched) return;
  const key = `${s.flavor}\0${s.text}`;
  if (streams.get(key) === s) streams.delete(key);
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

/** `text`'s chunks, parsed off the main thread; one stream per text, kept for the session's
 * recent large documents. */
export function chunkStream(text: string, flavor: MdFlavor): ChunkStream {
  const key = `${flavor}\0${text}`;
  const hit = streams.get(key);
  if (hit && !hit.failed) {
    streams.delete(key);
    streams.set(key, hit);
    return hit;
  }
  const s = new Stream(text, flavor);
  streams.set(key, s);
  if (streams.size > STREAMS_KEPT) streams.delete(streams.keys().next().value!);
  const w = theWorker();
  if (w) post(w, s);
  else onMainThread(s);
  return s;
}

/** Tests. */
export function resetChunkStreams(): void {
  streams.clear();
  inFlight.clear();
  worker?.terminate();
  worker = undefined;
  workerDied = false;
}
