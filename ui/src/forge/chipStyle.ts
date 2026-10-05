import type { CSSProperties } from 'react';

/** A forge label's colour reaches CSS as `--chip-color` (the CSS itself uses tokens only). */
export const chipStyle = (color?: string | null): CSSProperties | undefined => (color ? ({ '--chip-color': color } as CSSProperties) : undefined);
