import { useEffect, useState } from 'react';
import { api, errorMessage } from './api/client';
import type { GraphPayload } from './api/gen/GraphPayload';
import './graph/graph.css';
import { ContextMenu } from './menu/ContextMenu';
import { RepoView } from './repo/RepoView';
import { createServices, type RepoServices } from './repo/services';
import { Toast } from './ui/Toast';
import { TooltipHost } from './ui/TooltipHost';

type State =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; graph: GraphPayload; repo: number; repoPath: string; services: RepoServices };

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
        // One RepoServices per open repo: its message cache is shared by the graph tooltip and
        // the details panel.
        setState({ kind: 'ready', graph, repo: repo.id, repoPath: repo.path, services: createServices(repo.id) });
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
        : <RepoView key={state.repo} repo={state.repo} repoPath={state.repoPath} graph={state.graph} services={state.services} />)}
      <Toast />
      {/* The one context menu and its tooltip (spec §7). Plan 1C moves them to AppShell. */}
      <ContextMenu />
      <TooltipHost />
    </>
  );
}
