import { useEffect, useState } from 'react';
import { api, errorMessage } from './api/client';
import type { CommitMessage } from './api/gen/CommitMessage';
import type { GraphPayload } from './api/gen/GraphPayload';
import './graph/graph.css';
import { GraphView } from './graph/GraphView';
import { Toast } from './ui/Toast';

type State =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; graph: GraphPayload; repoPath: string; loadMessage: (id: string) => Promise<CommitMessage> };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const path = new URLSearchParams(location.search).get('repo') ?? (await api.launchRepo());
        if (!path) return live && setState({ kind: 'empty' });
        const t0 = performance.now();
        const repo = await api.openRepo(path);
        const graph = await api.graph(repo.id);
        if (!live) return;
        document.title = `GitBolt — ${repo.name}`;
        setState({ kind: 'ready', graph, repoPath: repo.path, loadMessage: (id) => api.commitMessage(repo.id, id) });
        requestAnimationFrame(() => console.info(`[gitbolt] graph ready in ${Math.round(performance.now() - t0)} ms (${graph.rows.length} rows)`));
      } catch (e) {
        if (live) setState({ kind: 'error', message: errorMessage(e) });
      }
    })();
    return () => { live = false; };
  }, []);

  return (
    <>
      {state.kind === 'loading' && <div className="center-message">Loading…</div>}
      {state.kind === 'empty' && <div className="center-message">No repository — run <code>just dev /path/to/repo</code></div>}
      {state.kind === 'error' && <div className="center-message" role="alert">{state.message}</div>}
      {state.kind === 'ready' && (state.graph.rows.length === 0 && state.graph.head.unborn
        ? <div className="center-message">No commits yet</div>
        : <GraphView graph={state.graph} repoId={state.repoPath} loadMessage={state.loadMessage} />)}
      <Toast />
    </>
  );
}
