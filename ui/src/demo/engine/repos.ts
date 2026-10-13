// The demo's repositories: the manifest's, each loaded from its bundle the first time something
// asks for it, and given an id when the UI opens it (as the core's handles: one per repository,
// whichever worktree opened it).
import { readBundle } from './bundle';
import { gbError } from './errors';
import type { GraphFactory } from './layout';
import { type MemFs, normalisePath } from './memfs';
import { demoRoot } from './paths';
import { DemoRepo } from './repo';

/** `rev`: the first 12 hex digits of the bundle's SHA-256, which the build adds to the manifest
 * it publishes (ui/build/demoDataRev.ts); absent in the committed manifest and in tests. */
export interface ManifestRepo { name: string; file: string; group: string | null; open: 'active' | 'tab' | null; rev?: string }
export interface ManifestGroup { name: string; color: string; collapsed: boolean }
export interface Manifest { version: 1; repos: ManifestRepo[]; groups: ManifestGroup[] }

/** Where the manifest and the bundles come from: the page's `demo-data/`, or a folder in tests. */
export interface DemoData {
  manifest(): Promise<Manifest>;
  bundle(file: string, rev?: string): Promise<Uint8Array>;
}

export class DemoRepos {
  readonly manifest: Manifest;
  private readonly data: DemoData;
  private readonly fs: MemFs;
  private readonly graph: GraphFactory;
  private readonly loading = new Map<string, Promise<DemoRepo>>();
  private readonly ready = new Map<string, DemoRepo>();
  private readonly opened = new Map<number, DemoRepo>();
  private nextId = 1;

  constructor(manifest: Manifest, data: DemoData, fs: MemFs, graph: GraphFactory) {
    this.manifest = manifest;
    this.data = data;
    this.fs = fs;
    this.graph = graph;
  }

  private entryFor(path: string): ManifestRepo | null {
    return this.manifest.repos.find((r) => [demoRoot(r.name, 'repo'), `/demo/.extra/${r.name}`].some((root) => path === root || path.startsWith(`${root}/`))) ?? null;
  }

  private load(entry: ManifestRepo): Promise<DemoRepo> {
    let p = this.loading.get(entry.name);
    if (!p) {
      p = (async () => {
        const bundle = await readBundle(await this.data.bundle(entry.file, entry.rev));
        if (bundle.name !== entry.name) throw gbError('Other', `${entry.file} holds ${bundle.name}, not ${entry.name}`);
        const repo = await DemoRepo.load(this.fs, bundle, this.graph());
        this.ready.set(entry.name, repo);
        return repo;
      })();
      this.loading.set(entry.name, p);
    }
    return p;
  }

  /** The repository called `name` once its bundle is open; `undefined` before. */
  loaded(name: string): DemoRepo | undefined {
    return this.ready.get(name);
  }

  /** The repository and the worktree holding `path`, loaded but not opened (no id). */
  async locate(path: string): Promise<{ repo: DemoRepo; worktree: string }> {
    const p = path.startsWith('/') ? normalisePath(path) : path;
    const entry = this.entryFor(p);
    if (entry) {
      const repo = await this.load(entry);
      const holding = (await repo.worktrees()).filter((w) => !w.bare && (p === w.path || p.startsWith(`${w.path}/`)));
      const w = holding.sort((a, b) => b.path.length - a.path.length)[0];
      if (w) return { repo, worktree: w.path };
    }
    throw gbError('NotFound', `Not a git repository: ${path}`);
  }

  /** `openRepo`: as `locate`, and the repository gets its id the first time. */
  async open(path: string): Promise<{ repo: DemoRepo; worktree: string }> {
    const found = await this.locate(path);
    if (found.repo.id === 0) {
      found.repo.id = this.nextId++;
      this.opened.set(found.repo.id, found.repo);
    }
    return found;
  }

  get(id: number): DemoRepo {
    const repo = this.opened.get(id);
    if (!repo) throw gbError('InvalidInput', `no open repository with id ${id}`);
    return repo;
  }
}
