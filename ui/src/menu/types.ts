import type { LucideIcon } from 'lucide-react';

/** Spec §7. Every row carries a leading icon and a tooltip; variants may be icon-only. */
export interface Variant { id: string; label?: string; icon?: LucideIcon; tooltip: string; run: () => void; disabledReason?: string }

export type MenuRow =
  | { kind: 'action'; id: string; label: string; icon: LucideIcon; tooltip: string; run: () => void; variants?: Variant[]; disabledReason?: string; shortcut?: string }
  /** `initial`: the id of the row the submenu opens on (e.g. the last used opener); else its
   * first enabled row. */
  | { kind: 'submenu'; id: string; label: string; icon: LucideIcon; tooltip: string; rows: MenuRow[]; initial?: string }
  | { kind: 'separator' };
