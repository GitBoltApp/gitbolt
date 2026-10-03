/**
 * UX round 2 G.1: the one layer, on `<body>`, where every editor's overflowing widgets draw:
 * hovers, the "Cannot edit in read-only editor" message, the suggest list. Inside the editor
 * they're clipped by its box (`.text-diff`'s `overflow: hidden`), so a message above line 1 hid
 * under the file bar; and `position: fixed` alone isn't enough, since the diff panel is a size
 * container (layout containment makes it the containing block of fixed descendants).
 *
 * It carries `monaco-editor` so Monaco's widget styles and the theme's colour variables apply. The
 * editors take it as `overflowWidgetsDomNode` when they're created, with `fixedOverflowWidgets`
 * (options.ts) so they place the widgets in viewport coordinates. Styled inline (the merge tool
 * may create an editor before the diff panel's stylesheet loads): a 0×0 fixed box at the
 * viewport's corner, above the panels and bars but under hover cards (700), modals (800) and
 * menus (900).
 */
let layer: HTMLElement | null = null;

export const OVERFLOW_LAYER_CLASS = 'monaco-overflow-layer';
export const OVERFLOW_LAYER_Z = 600;

export function overflowLayer(): HTMLElement {
  if (layer?.isConnected) return layer;
  layer = document.createElement('div');
  layer.className = `monaco-editor ${OVERFLOW_LAYER_CLASS}`;
  Object.assign(layer.style, { position: 'fixed', top: '0', left: '0', width: '0', height: '0', overflow: 'visible', zIndex: String(OVERFLOW_LAYER_Z), background: 'none' });
  document.body.appendChild(layer);
  return layer;
}
