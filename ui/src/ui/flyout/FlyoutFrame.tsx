import { ArrowLeftToLine, ArrowRightFromLine, X } from 'lucide-react';
import { use, useEffect, useRef, type ReactNode } from 'react';
import { HoverTooltip } from '../HoverTooltip';
import { FlyoutDockContext, type FlyoutDock } from './flyout';
import './flyout.css';

export interface FlyoutFrameProps {
  /** Its accessible name ("Merge request !12", "Create merge request"). */
  label: string;
  /** The heading at its top. */
  title: ReactNode;
  onClose(): void;
  /** Icon buttons left of the × (Open in browser). */
  headerActions?: ReactNode;
  /** Pinned under the scrolling body (a form's buttons). */
  footer?: ReactNode;
  /** A long title wraps onto more lines instead of ending in an ellipsis (an MR/PR's title). */
  wrapTitle?: boolean;
  children: ReactNode;
}

/** The frame every flyout draws: a header (title, actions, ×), a scrolling body, an optional
 * footer. Not modal: the graph beside it stays usable. Its heading takes the focus when it opens,
 * so Esc works at once. A dockable flyout's header has the dock button first (left of
 * `headerActions`). */
export function FlyoutFrame({ label, title, onClose, headerActions, footer, wrapTitle = false, children }: FlyoutFrameProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const dock = use(FlyoutDockContext);
  useEffect(() => {
    // A list that drives the flyout with its arrow keys (the sidebar's MR/PR rows) keeps its focus.
    if (document.activeElement?.closest('[data-keep-flyout-focus]')) return;
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section className="flyout" role="dialog" aria-modal="false" aria-label={label} data-flyout="">
      <header className={`flyout-head${wrapTitle ? ' wrap' : ''}`}>
        <h2 ref={heading} tabIndex={-1} className="flyout-title">{title}</h2>
        {dock?.dockable && <DockButton dock={dock} />}
        {headerActions}
        <HoverTooltip content="Close (Esc)">
          <button type="button" className="icon-button flyout-close" aria-label="Close" onClick={onClose}><X size={14} aria-hidden /></button>
        </HoverTooltip>
      </header>
      <div className="flyout-body">{children}</div>
      {footer && <footer className="flyout-foot">{footer}</footer>}
    </section>
  );
}

/** Docks the flyout beside the graph ("<-|"), or floats it over the graph again. */
function DockButton({ dock }: { dock: FlyoutDock }) {
  const tip = dock.docked ? 'Undock (float over the graph)' : dock.canDock ? 'Dock beside the graph' : 'The window is too narrow to dock';
  return (
    <HoverTooltip content={tip}>
      <button type="button" className="icon-button flyout-dock" aria-label={dock.docked ? 'Undock (float over the graph)' : 'Dock beside the graph'} aria-pressed={dock.docked} disabled={!dock.docked && !dock.canDock} onClick={dock.toggle}>
        {dock.docked ? <ArrowRightFromLine size={14} aria-hidden /> : <ArrowLeftToLine size={14} aria-hidden />}
      </button>
    </HoverTooltip>
  );
}
