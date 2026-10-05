import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { HoverTooltip } from '../HoverTooltip';
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
 * so Esc works at once. */
export function FlyoutFrame({ label, title, onClose, headerActions, footer, wrapTitle = false, children }: FlyoutFrameProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // A list that drives the flyout with its arrow keys (the sidebar's MR/PR rows) keeps its focus.
    if (document.activeElement?.closest('[data-keep-flyout-focus]')) return;
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section className="flyout" role="dialog" aria-modal="false" aria-label={label} data-flyout="">
      <header className={`flyout-head${wrapTitle ? ' wrap' : ''}`}>
        <h2 ref={heading} tabIndex={-1} className="flyout-title">{title}</h2>
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
