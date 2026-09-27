import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import { DEFAULT_DIFF_PREFS, type DiffPrefs } from '../diffPrefs';
import { diffEditorOptions, fileViewOptions } from '../options';
import { monaco } from './setup';
import { EDITOR_THEME, ensureLanguage, ensureTheme } from './shiki';

export interface DiffShowRequest { path: string; original: string; modified: string; language: string; prefs: DiffPrefs }
export interface FileShowRequest { path: string; text: string; language: string; wordWrap: boolean }
export interface EditorContextMenuEvent {
  path: string;
  side: 'original' | 'modified' | 'file';
  line: number;
  selection: { startLine: number; endLine: number } | null;
  x: number;
  y: number;
}

export interface MonacoHost {
  attachDiff(el: HTMLElement): void;
  detachDiff(el: HTMLElement): void;
  /** Resolves once Monaco has computed the diff. A newer call makes an older one a no-op.
   * `attachDiff` must have run first: before that there's no diff editor, and it resolves
   * without showing anything. */
  showDiff(req: DiffShowRequest): Promise<void>;
  setDiffPrefs(prefs: DiffPrefs): void;
  goToChange(direction: 'next' | 'previous'): void;
  attachFile(el: HTMLElement): void;
  detachFile(el: HTMLElement): void;
  /** `attachFile` must have run first: before that there's no file editor, and it resolves
   * without showing anything. */
  showFile(req: FileShowRequest): Promise<void>;
  /** File View's word wrap, applied in place: the model (and so the scroll position) is kept. */
  setFileWordWrap(on: boolean): void;
  /** Puts the keyboard in the attached editor: the diff's modified side, else the file editor.
   * A no-op while neither is attached. */
  focus(): void;
  /** Plan 1C seam: its context menu replaces Monaco's. `null` restores Monaco's own menu, which
   * stays on in 1B (plan 1B deviation 1). */
  setContextMenuHandler(handler: ((e: EditorContextMenuEvent) => void) | null): void;
  layout(): void;
}

type Side = EditorContextMenuEvent['side'];

/** One diff editor and one file editor for the whole app (spec §4.4), re-parented into whichever
 * container attaches. */
class Host implements MonacoHost {
  private readonly diffEl = document.createElement('div');
  private readonly fileEl = document.createElement('div');
  private diff: MonacoNs.editor.IStandaloneDiffEditor | null = null;
  private file: MonacoNs.editor.IStandaloneCodeEditor | null = null;
  private diffModels: MonacoNs.editor.ITextModel[] = [];
  private fileModel: MonacoNs.editor.ITextModel | null = null;
  // The latest diff prefs and File View wrap, whoever set them last: a show call adopts its own
  // at call time, and a later set* call during its grammar load still wins.
  private prefs: DiffPrefs = DEFAULT_DIFF_PREFS;
  private fileWrap = DEFAULT_DIFF_PREFS.wordWrap;
  private computedCount = 0;
  private menu: ((e: EditorContextMenuEvent) => void) | null = null;
  private diffPath = '';
  private filePath = '';
  private diffSeq = 0;
  private fileSeq = 0;
  private readonly ro = new ResizeObserver(() => this.layout());

  constructor() {
    this.diffEl.className = 'monaco-host';
    this.fileEl.className = 'monaco-host';
  }

  attachDiff(el: HTMLElement): void {
    el.appendChild(this.diffEl);
    this.ro.observe(el);
    if (!this.diff) {
      this.diff = monaco.editor.createDiffEditor(this.diffEl, { ...diffEditorOptions(this.prefs, this.menu === null), theme: EDITOR_THEME });
      // A plain DOM signal that a diff (or a prefs recompute) is done, for e2e waits.
      this.diff.onDidUpdateDiff(() => {
        this.diffEl.dataset.diffComputed = String(++this.computedCount);
      });
      this.wireMenu(this.diff.getOriginalEditor(), 'original');
      this.wireMenu(this.diff.getModifiedEditor(), 'modified');
    }
    this.layout();
  }

  detachDiff(el: HTMLElement): void {
    this.ro.unobserve(el);
    if (this.diffEl.parentElement === el) el.removeChild(this.diffEl);
  }

  async showDiff(req: DiffShowRequest): Promise<void> {
    const seq = ++this.diffSeq;
    this.prefs = req.prefs;
    const lang = await ensureLanguage(monaco, req.language);
    const ed = this.diff;
    if (seq !== this.diffSeq || !ed) return;
    this.diffPath = req.path;
    this.setDiffPrefs(this.prefs);
    const original = monaco.editor.createModel(req.original, lang);
    const modified = monaco.editor.createModel(req.modified, lang);
    const computed = new Promise<void>((resolve) => {
      // Backstop in case Monaco never reports the diff; whichever fires first cleans up both.
      const done = () => {
        clearTimeout(timer);
        sub.dispose();
        resolve();
      };
      const sub = ed.onDidUpdateDiff(done);
      const timer = setTimeout(done, 5000);
    });
    ed.setModel({ original, modified });
    for (const m of this.diffModels) m.dispose();
    this.diffModels = [original, modified];
    await computed;
  }

  setDiffPrefs(prefs: DiffPrefs): void {
    this.prefs = prefs;
    this.diff?.updateOptions(diffEditorOptions(prefs, this.menu === null));
  }

  goToChange(direction: 'next' | 'previous'): void {
    this.diff?.goToDiff(direction);
  }

  attachFile(el: HTMLElement): void {
    el.appendChild(this.fileEl);
    this.ro.observe(el);
    if (!this.file) {
      this.file = monaco.editor.create(this.fileEl, { ...fileViewOptions(this.fileWrap, this.menu === null), theme: EDITOR_THEME });
      this.wireMenu(this.file, 'file');
    }
    this.layout();
  }

  detachFile(el: HTMLElement): void {
    this.ro.unobserve(el);
    if (this.fileEl.parentElement === el) el.removeChild(this.fileEl);
  }

  async showFile(req: FileShowRequest): Promise<void> {
    const seq = ++this.fileSeq;
    this.fileWrap = req.wordWrap;
    const lang = await ensureLanguage(monaco, req.language);
    const ed = this.file;
    if (seq !== this.fileSeq || !ed) return;
    this.filePath = req.path;
    ed.updateOptions(fileViewOptions(this.fileWrap, this.menu === null));
    const model = monaco.editor.createModel(req.text, lang);
    ed.setModel(model);
    this.fileModel?.dispose();
    this.fileModel = model;
  }

  setFileWordWrap(on: boolean): void {
    this.fileWrap = on;
    this.file?.updateOptions({ wordWrap: on ? 'on' : 'off' });
  }

  focus(): void {
    if (this.diff && this.diffEl.parentElement) this.diff.getModifiedEditor().focus();
    else if (this.file && this.fileEl.parentElement) this.file.focus();
  }

  setContextMenuHandler(handler: ((e: EditorContextMenuEvent) => void) | null): void {
    this.menu = handler;
    this.diff?.updateOptions({ contextmenu: handler === null });
    this.file?.updateOptions({ contextmenu: handler === null });
  }

  layout(): void {
    const size = (el: HTMLElement) => ({ width: el.parentElement?.clientWidth ?? 0, height: el.parentElement?.clientHeight ?? 0 });
    if (this.diff && this.diffEl.parentElement) this.diff.layout(size(this.diffEl));
    if (this.file && this.fileEl.parentElement) this.file.layout(size(this.fileEl));
  }

  private wireMenu(ed: MonacoNs.editor.ICodeEditor, side: Side): void {
    ed.onContextMenu((e) => {
      if (!this.menu) return;
      // With `contextmenu: false` Monaco no longer suppresses the webview's native menu.
      e.event.preventDefault();
      const sel = ed.getSelection();
      this.menu({
        path: side === 'file' ? this.filePath : this.diffPath,
        side,
        line: e.target.position?.lineNumber ?? sel?.startLineNumber ?? 1,
        selection: sel && !sel.isEmpty() ? { startLine: sel.startLineNumber, endLine: sel.endLineNumber } : null,
        x: e.event.posx,
        y: e.event.posy,
      });
    });
  }
}

let host: Host | undefined;

/** The app's one host. The editor theme is defined before it's handed out, so the first editor
 * is created in it (see `ensureTheme`). Reached only through `loadMonacoHost`. */
export async function createHost(): Promise<MonacoHost> {
  await ensureTheme(monaco);
  return (host ??= new Host());
}
