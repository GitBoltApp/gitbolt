import type { Literal } from 'mdast';
import type { ReactNode } from 'react';

// --- the shared contract with plan 5B (verbatim) ---
export type MdFlavor = 'github' | 'gitlab';

export type MarkdownContext =
  | { kind: 'forge'; tabId: string }                       // MR/PR view: project and host come from forgeOf(tabId)
  | { kind: 'file'; tabId: string; commit: string | 'worktree'; path: string }; // File View: the .md file's own path

export interface MarkdownProps {
  text: string;
  flavor: MdFlavor;
  context: MarkdownContext;
  /** Bodies over this many bytes render as plain text (MR view: 1 MB). Default 5 MB. */
  maxBytes?: number;
  className?: string;
}

/** What a link does on a plain click (spec §4.1). */
export type LinkTarget =
  | { kind: 'mr'; number: number; webUrl: string }           // in-app MR/PR view
  | { kind: 'commit'; sha: string; webUrl: string | null }    // select in graph; webUrl when not local
  | { kind: 'file'; path: string; commit: string | 'worktree'; anchor: string | null } // 5B handles it
  | { kind: 'anchor'; id: string }                            // scroll within the document
  | { kind: 'external'; url: string }                         // browser
  | { kind: 'inert' };

export type ImageSource =
  | { kind: 'forge'; url: string }        // auto-load through core `forgeImage { repo, url }`
  | { kind: 'remote'; url: string; host: string } // click-to-load
  | { kind: 'repo'; path: string; commit: string | 'worktree' } // 5B's loader
  | { kind: 'data'; url: string }         // data:image/(png|gif|jpeg|webp)
  | { kind: 'none' };

export interface LinkMenuTarget { ctx: MarkdownContext; target: LinkTarget; href: string; text: string }
// --- end of the shared contract ---

export type FileMarkdownContext = Extract<MarkdownContext, { kind: 'file' }>;

/** A reference the `references` plugin found (spec §3.1). */
export interface MdReferenceNode extends Literal {
  type: 'reference';
  /** `issue`: `#n` (on GitHub, a PR or an issue); `mr`: GitLab's `!n`. */
  refKind: 'issue' | 'mr' | 'commit' | 'mention';
  /** `owner/repo` or `group/sub/project` when written; null: this project. */
  project: string | null;
  number: number | null;
  sha: string | null;
  user: string | null;
  /** The text as written: what the link shows. */
  value: string;
}

declare module 'mdast' {
  interface PhrasingContentMap { reference: MdReferenceNode }
  interface RootContentMap { reference: MdReferenceNode }
}

/** The element overrides' props (render.tsx passes them; T6–T8 implement the components). */
/** `id`, `name` and `aria-describedby` are the anchor's own (already `user-content-` prefixed):
 * `<a name>` targets and footnote back-link targets need them. */
export interface MdLinkProps { ctx: MarkdownContext; href: string; id?: string; name?: string; 'aria-describedby'?: string; children?: ReactNode }
export interface MdReferenceProps { ctx: MarkdownContext; node: MdReferenceNode }
export interface MdImageProps { ctx: MarkdownContext; src: string; alt: string; width?: number; height?: number }
/** `marks` (5C, R10): a changed block's merged lines, one of ' ' (kept), '-' (removed), '+' (added) per line. */
/** `words` (5C): a changed block's changed words per line, one `;`-separated entry per line of
 * `start-end` character ranges, `,` between them (diff/words.ts `codeLines`). */
/** `signs`: a -/+ column on the marked lines (a suggestion's diff), so it reads as one without
 * the colours. */
export interface MdCodeProps { code: string; lang: string | null; marks?: string; words?: string; signs?: boolean }
export interface MdMermaidProps { source: string }
