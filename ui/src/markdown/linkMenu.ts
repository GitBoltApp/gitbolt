import { copyText } from '../api/transport';
import { ICONS } from '../menu/icons';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { useToast } from '../ui/toastStore';
import { hasFileLinkHandler, openExternal, openLinkTarget } from './actions';
import { browserUrlFor, linkTooltip } from './links';
import type { LinkMenuTarget } from './types';

// A link in rendered Markdown (the `link` kind, spec §4.1). Built from memory, as every menu.

type Action = Extract<MenuRow, { kind: 'action' }>;
const row = (r: Omit<Action, 'kind'>): MenuRow => ({ kind: 'action', ...r });
const copy = (text: string) => { copyText(text).then(() => useToast.getState().show('Copied'), () => useToast.getState().show('Copy failed', { error: true })); };

/** The target opens inside GitBolt: an MR/PR, a loaded commit, a file 5B shows. */
function inApp(t: LinkMenuTarget): boolean {
  switch (t.target.kind) {
    case 'mr': return true;
    case 'commit': return t.target.webUrl === null;
    case 'file': return t.ctx.kind === 'file' && hasFileLinkHandler();
    default: return false;
  }
}

export const offLinkMenus: Array<() => void> = [
  registerMenu<LinkMenuTarget, unknown>({
    id: 'link.open', kind: 'link', group: 'open', order: 0,
    rows: (t) => {
      const rows: MenuRow[] = [];
      if (inApp(t)) rows.push(row({ id: 'link.openInApp', label: 'Open in GitBolt', icon: t.target.kind === 'commit' ? ICONS.graph : t.target.kind === 'file' ? ICONS.file : ICONS.mr, tooltip: linkTooltip(t.ctx, t.target) ?? 'Open in GitBolt', run: () => { void openLinkTarget(t.ctx, t.target); } }));
      const url = browserUrlFor(t.ctx, t.target);
      if (url) rows.push(row({ id: 'link.openInBrowser', label: 'Open in browser', icon: ICONS.browser, tooltip: url, run: () => openExternal(url) }));
      return rows;
    },
  }),
  registerMenu<LinkMenuTarget, unknown>({
    id: 'link.copy', kind: 'link', group: 'copy', order: 0,
    rows: (t) => {
      const link = browserUrlFor(t.ctx, t.target) ?? (t.href.trim() || null);
      return [
        ...(link ? [row({ id: 'link.copyLink', label: 'Copy link', icon: ICONS.forge, tooltip: `Copy ${link}`, run: () => copy(link) })] : []),
        row({ id: 'link.copyText', label: 'Copy text', icon: ICONS.copy, tooltip: `Copy “${t.text}”`, run: () => copy(t.text) }),
      ];
    },
  }),
];
import.meta.hot?.dispose(() => offLinkMenus.forEach((off) => off()));
