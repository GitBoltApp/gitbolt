import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { api } from '../api/client';
import './errors.css';

interface Props { name: string; /** A crashed panel clears itself when this changes (a new selection or file). */ resetKey?: unknown; children: ReactNode }
interface State { error: Error | null; generation: number }

/** A panel that throws while rendering shows a compact fallback with Retry instead of taking the
 * app down (spec §16.1); the crash is logged through the frontend log (T7). Retry remounts it. */
export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null, generation: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState((s) => ({ error: null, generation: s.generation + 1 }));
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void api.logFrontend('error', `${this.props.name} panel crashed: ${error.message}`, `${error.stack ?? error.message}\n${info.componentStack ?? ''}`).catch(() => {});
  }

  render(): ReactNode {
    const { error, generation } = this.state;
    if (error) {
      return (
        <div role="alert" className="panel-crash" data-panel={this.props.name}>
          <p>{this.props.name} crashed: {error.message}</p>
          <button type="button" className="panel-crash-retry" onClick={() => this.setState((s) => ({ error: null, generation: s.generation + 1 }))}>Retry</button>
        </div>
      );
    }
    return <Fragment key={generation}>{this.props.children}</Fragment>;
  }
}
