import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { buildMenu } from '../menu/registry';
import { openContextMenu } from '../menu/menuStore';
import { HoverTooltip, type TooltipContent } from '../ui/HoverTooltip';
import { openExternal, openLinkTarget } from './actions';
import './linkMenu';
import { browserUrlFor, linkTooltip, resolveLink } from './links';
import type { LinkMenuTarget, LinkTarget, MarkdownContext, MdLinkProps } from './types';

/** The anchor's own attributes, kept on what renders: `<a name>` and footnote targets. */
export type AnchorAttrs = Pick<MdLinkProps, 'id' | 'name' | 'aria-describedby'>;

/** A link (or reference) as rendered: no `href` (nothing for the webview to navigate, ruling 12);
 * a plain click goes where `target` says, Ctrl/Cmd+click to the browser, right-click the `link`
 * menu; the instant tooltip shows the target first. An inert target is plain text. */
export function LinkView({ ctx, target, href, className, tooltip, anchor, children }: { ctx: MarkdownContext; target: LinkTarget; href: string; className?: string; tooltip?: TooltipContent; anchor?: AnchorAttrs; children: ReactNode }) {
  const ref = useRef<HTMLAnchorElement>(null);
  if (target.kind === 'inert') {
    // An inert reference keeps its `md-ref` class (no forge: `!5` still reads as a reference).
    const cls = className ? `md-inert ${className}` : 'md-inert';
    // A bare `<a name>` / `<a id>` stays an `a` (no href: not a link), a scroll target.
    return anchor?.id || anchor?.name ? <a {...anchor} className={cls}>{children}</a> : <span className={cls}>{children}</span>;
  }
  const activate = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      const url = browserUrlFor(ctx, target);
      if (url) openExternal(url);
      return;
    }
    void openLinkTarget(ctx, target, ref.current ?? undefined);
  };
  const tip = tooltip ?? linkTooltip(ctx, target);
  const link = (
    <a
      {...anchor}
      ref={ref}
      role="link"
      tabIndex={0}
      className={className ? `md-link ${className}` : 'md-link'}
      onClick={activate}
      onAuxClick={(e) => e.preventDefault()}
      onKeyDown={(e) => { if (e.key === 'Enter') activate(e); }}
      onContextMenu={(e) => openContextMenu(e, () => buildMenu<LinkMenuTarget, unknown>('link', { ctx, target, href, text: ref.current?.textContent ?? '' }, null))}
    >
      {children}
    </a>
  );
  return tip ? <HoverTooltip content={tip}>{link}</HoverTooltip> : link;
}

export function MdLink({ ctx, href, id, name, 'aria-describedby': describedBy, children }: MdLinkProps) {
  return <LinkView ctx={ctx} target={resolveLink(ctx, href, '')} href={href} anchor={{ id, name, 'aria-describedby': describedBy }}>{children}</LinkView>;
}
