/**
 * git's branch-name rules (spec #2 §9.1: validated live in the create and rename dialogs), word
 * for word the backend's `write::names::branch_name_error`. The backend checks again; this is
 * so the dialog can say why before anything is sent.
 */
export function branchNameError(name: string): string | null {
  if (!name) return 'Enter a branch name';
  if (name === 'HEAD') return "HEAD isn't a branch name";
  if (name.startsWith('-')) return "A branch name can't start with -";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return "A branch name can't contain spaces or ~ ^ : ? * [ \\";
  if (name.includes('..')) return "A branch name can't contain ..";
  if (name === '@' || name.includes('@{')) return "A branch name can't be @ or contain @{";
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return "A branch name can't have an empty part between slashes";
  if (name.endsWith('.')) return "A branch name can't end with .";
  if (name.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'))) return 'No part of a branch name can start with . or end with .lock';
  return null;
}
