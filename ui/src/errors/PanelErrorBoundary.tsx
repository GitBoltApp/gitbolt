import { Component, Fragment, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react';
import { api } from '../api/client';
import { registerKeys } from '../ui/keyRouter';
import { isEditableTarget } from '../ui/keys';
import './errors.css';

interface Props {
  name: string;
  /** A crashed panel clears itself when this changes (a new selection or file). */
  resetKey?: unknown;
  /** A panel that can be closed (a center view): its crash offers Close, and Esc closes it too,
   * since the panel's own × and Esc went with it. */
  onClose?: () => void;
  children: ReactNode;
}
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
          <div className="panel-crash-actions">
            <button type="button" className="panel-crash-retry" onClick={() => this.setState((s) => ({ error: null, generation: s.generation + 1 }))}>Retry</button>
            {this.props.onClose && <CloseCrashed name={this.props.name} onClose={this.props.onClose} />}
          </div>
        </div>
      );
    }
    return <Fragment key={generation}>{this.props.children}</Fragment>;
  }
}

/** A crashed closable panel's Close, and its Esc (from anywhere in the shown tab, unless a text box
 * has it): the app's own Esc stands aside for the panel (a center view on top). */
function CloseCrashed({ name, onClose }: { name: string; onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => registerKeys('app', (e) => {
    if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing || e.defaultPrevented) return;
    if (ref.current?.checkVisibility?.() === false) return;
    if (isEditableTarget(e.target instanceof Element ? e.target : null)) return;
    e.preventDefault();
    onClose();
    return 'handled';
  }), [onClose]);
  return <button ref={ref} type="button" className="panel-crash-retry" aria-label={`Close ${name.toLowerCase()}`} onClick={onClose}>Close</button>;
}
