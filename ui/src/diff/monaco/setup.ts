// Lean Monaco: the core editor API plus every editor and diff-editor contribution (find,
// folding, sticky scroll, the diff editor's own actions, …), but no Monarch languages and no
// TypeScript/CSS/HTML/JSON language services (spec §10.2); Shiki tokenizes (§10.3).
// monaco-editor 0.57's exports map is "./*" -> "./esm/vs/*.js", so deep paths drop "esm/vs/"
// (verified in plan 1B; the WebKit spike's `monaco-editor/esm/vs/...` paths don't resolve).
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/features/register.all';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export { monaco };
export type Monaco = typeof monaco;
