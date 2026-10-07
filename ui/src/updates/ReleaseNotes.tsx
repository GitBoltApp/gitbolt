import { Markdown } from '../markdown/Markdown';

/** No tab's forge behind it: links open in the browser, references stay text. */
const CONTEXT = { kind: 'forge', tabId: 'gitbolt-update' } as const;

/** A release's notes (GitHub-flavoured Markdown), loaded with the dialog, never at startup. */
export default function ReleaseNotes({ text }: { text: string }) {
  return <Markdown text={text} flavor="github" context={CONTEXT} />;
}
