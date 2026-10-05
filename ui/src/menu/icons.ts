import {
  AppWindow, ArrowRightToLine, Check, CircleAlert, Flag, Code, Columns3, Copy, Download, ExternalLink, Eye, EyeOff, FileCode, FileDiff, FileText, FolderGit2, FolderOpen,
  GitBranch, GitCommitHorizontal, GitCompare, GitGraph, GitPullRequest, Hash, LoaderCircle, MessageSquare, Pencil, RotateCcw, Settings, SquareArrowOutUpRight, SquareX, Tag, X,
} from 'lucide-react';

/** One icon per action type, shared by every menu (spec §7 "Icons"), so the same action always
 * looks the same. Later sub-projects add theirs here. */
export const ICONS = {
  /** The chosen main remote (checked) and the unchosen one. */
  check: Check,
  mainRemote: Flag,
  copy: Copy,
  sha: Hash,
  message: MessageSquare,
  forge: ExternalLink,
  /** Opening a URL in the browser (the forge row's Open variant). */
  browser: SquareArrowOutUpRight,
  branch: GitBranch,
  commit: GitCommitHorizontal,
  tag: Tag,
  mr: GitPullRequest,
  compare: GitCompare,
  /** Select a commit in the graph. */
  graph: GitGraph,
  editor: Code,
  /** An "Open in…" editor entry. */
  editorApp: FileCode,
  reveal: FolderOpen,
  /** The system's "Open With" chooser ("Other…"). */
  openWith: AppWindow,
  diff: FileDiff,
  file: FileText,
  rename: Pencil,
  close: X,
  closeOthers: SquareX,
  closeRight: ArrowRightToLine,
  reopen: RotateCcw,
  repo: FolderGit2,
  columns: Columns3,
  show: Eye,
  hide: EyeOff,
  fetch: Download,
  settings: Settings,
  /** A row standing in for content that's still loading. */
  loading: LoaderCircle,
  /** A row standing in for content that failed to load. */
  error: CircleAlert,
} as const;
