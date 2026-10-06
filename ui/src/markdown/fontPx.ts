import { createContext } from 'react';

/** The text size of rendered Markdown's pane, in px (markdown.css's `--md-font-size`): File View's
 * and the diff's follow the editor font size (diff/fontZoom.ts); anywhere else 12. A chunk's
 * placeholder height scales with it (`chunkHeightOf`). */
export const MD_BASE_FONT_PX = 12;
export const MdFontPx = createContext(MD_BASE_FONT_PX);
