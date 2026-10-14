// The answers the demo gives as fixed or plausible values (website demo spec §4.3, "canned"): the
// logs, the diagnostics text, the update state, the openers, the repositories under /demo, and
// the editor template check.
import type { OpenerPayload } from '../../api/gen/OpenerPayload';
import type { ScannedRepo } from '../../api/gen/ScannedRepo';
import type { DemoContext } from '../context';
import { redact } from '../engine/remotes';
import { compareBytewise } from '../engine/read/bytes';
import { fail, viewOf } from '../engine/read/seam';
import { listWorktrees } from '../engine/read/worktrees';
import { commandEntries, requestEntries } from '../log';
import type { HandlerTable } from '../transport';

export const DEMO_ROOT = '/demo';
const LOADED_AT = Math.floor(Date.now() / 1000);
const OPENERS: OpenerPayload[] = [
  { id: 'vscode', name: 'VS Code', kind: 'editor' },
  { id: 'file-manager', name: 'Files', kind: 'fileManager' },
];

/** The repositories a folder holds: the manifest's, under /demo, newest first. Each one's branch
 * shows once its bundle is open (the demo opens none until asked). */
async function scan(ctx: DemoContext, root: string): Promise<ScannedRepo[]> {
  const folder = root.length > 1 ? root.replace(/\/+$/, '') : root;
  if (folder !== DEMO_ROOT) return [];
  const out: ScannedRepo[] = [];
  for (const [i, m] of ctx.repos.manifest.repos.entries()) {
    const open = ctx.repos.loaded(m.name);
    const main = open ? (await listWorktrees(viewOf(open))).find((w) => w.isMain) : undefined;
    const branch = main?.branch?.replace(/^refs\/heads\//, '') ?? null;
    out.push({ path: `${DEMO_ROOT}/${m.name}`, name: m.name, branch, modified: LOADED_AT - i * 60 });
  }
  return out;
}

/** The core's `redact` and `scrub_settings`: secret-looking keys masked, every string redacted. */
const SECRET_KEYS = ['token', 'password', 'passphrase', 'secret', 'authorization', 'credential', 'apikey', 'api_key', 'privatekey', 'private_key'];

function scrubSettings(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrubSettings);
  if (typeof v === 'string') return redact(v);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, val]) => {
      const lower = k.toLowerCase();
      return [k, SECRET_KEYS.some((s) => lower.includes(s)) ? '***' : scrubSettings(val)];
    }),
  );
}

// The core's openers::template_opener, for the checks that need no PATH: the browser has no
// editors to resolve, so the program is taken on trust.
const SHELL_PROGRAMS = ['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'mksh', 'csh', 'tcsh', 'ash', 'busybox', 'env', 'perl', 'ruby', 'node', 'nodejs', 'php', 'lua', 'tclsh', 'pwsh', 'osascript'];
const PLACEHOLDERS = ['{file}', '{line}', '{repo}'];

/** Whitespace-separated words, with '…', "…" and backslash escapes; a placeholder stays literal. */
function tokenize(template: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === "'" || c === '"') {
      inWord = true;
      let closed = false;
      for (i++; i < template.length; i++) {
        const d = template[i];
        if (d === c) {
          closed = true;
          break;
        }
        if (d === '\\' && c === '"' && i + 1 < template.length) cur += template[++i];
        else cur += d;
      }
      if (!closed) fail('InvalidInput', 'unterminated quote in the editor command');
    } else if (c === '\\') {
      inWord = true;
      if (i + 1 < template.length) cur += template[++i];
    } else if (/\s/.test(c)) {
      if (inWord) {
        out.push(cur);
        cur = '';
        inWord = false;
      }
    } else {
      inWord = true;
      cur += c;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

/** An option word that makes the next argument code: `-c`, `-lc`, `-e`, `--command=…`, … */
function isCodeFlag(word: string): boolean {
  if (word.startsWith('--')) return ['command', 'eval', 'exec', 'execute'].includes(word.slice(2).split('=')[0]);
  const short = /^-([A-Za-z]+)/.exec(word)?.[1];
  return short !== undefined && /[ceEr]/.test(short);
}

const hasPlaceholder = (w: string): boolean => PLACEHOLDERS.some((p) => w.includes(p));

/** Throws the InvalidInput the core gives for a template it would refuse. */
export function checkEditorTemplate(template: string): void {
  const [program, ...args] = tokenize(template);
  if (program === undefined) fail('InvalidInput', 'empty editor command');
  const base = program.split(/[/\\]/).pop() ?? program;
  const shell = SHELL_PROGRAMS.includes(base) || base.startsWith('python');
  // A placeholder is safe only as its own whole word that isn't code (the core's I1 rule).
  const codeArg = args.some((w) => hasPlaceholder(w) && !PLACEHOLDERS.includes(w)) || args.some((w, i) => i + 1 < args.length && isCodeFlag(w) && hasPlaceholder(args[i + 1]));
  if (shell && codeArg) {
    fail('InvalidInput', "a shell or interpreter's code argument can't contain {file}, {line} or {repo}: pass them as separate arguments after the code instead");
  }
}

export const cannedHandlers: Pick<
  HandlerTable,
  'commandLog' | 'requestLog' | 'diagnostics' | 'updateStatus' | 'updateCheck' | 'updateCancel' | 'listOpeners' | 'listOpenersFor' | 'scanRepos' | 'scanFolders' | 'suggestReposFolder' | 'validateEditorTemplate'
> = {
  commandLog: async () => commandEntries(),
  requestLog: async () => requestEntries(),
  diagnostics: async ({ ui }) => {
    const chromium = /Chrome\/(\S+)/.exec(ui.userAgent)?.[1] ?? 'unknown';
    const os = typeof navigator !== 'undefined' && navigator.platform ? navigator.platform : 'unknown';
    const settings = JSON.stringify(scrubSettings(ui.settings), null, 2) ?? 'null';
    return `GitVolt (web demo)\nRuntime: browser\nChromium: ${chromium}\nOS: ${os}\nSession: web\ngit: isomorphic-git (in the browser)\nSettings:\n${settings}\n`;
  },
  // The demo ships no updates: it is always the release it was built from.
  updateStatus: async () => ({ state: 'upToDate' }),
  updateCheck: async () => ({ state: 'upToDate' }),
  updateCancel: async () => ({ state: 'upToDate' }),
  listOpeners: async () => OPENERS,
  listOpenersFor: async () => OPENERS,
  suggestReposFolder: async () => DEMO_ROOT,
  scanRepos: async ({ root }, ctx) => scan(ctx, root),
  scanFolders: async ({ roots }, ctx) => {
    const byPath = new Map<string, ScannedRepo>();
    for (const root of new Set(roots)) for (const r of await scan(ctx, root)) if (!byPath.has(r.path)) byPath.set(r.path, r);
    return [...byPath.values()].sort((a, b) => b.modified - a.modified || compareBytewise(a.path, b.path));
  },
  validateEditorTemplate: async ({ template }) => {
    checkEditorTemplate(template);
    return null;
  },
};
