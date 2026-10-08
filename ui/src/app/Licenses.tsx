import { useEffect, useState } from 'react';
import { osKind } from './osPath';
import './licenses.css';

/** The notices the production build puts in dist/licenses/ (ui/build/licenses.ts), by file name. */
const KNOWN: Record<string, { label: string; detail: string }> = {
  'LICENSE.txt': { label: 'GitBolt', detail: 'MIT license' },
  'THIRD-PARTY-NOTICES-ui.txt': { label: 'Interface', detail: 'npm packages, Shiki grammars and themes' },
  'THIRD-PARTY-NOTICES-rust.txt': { label: 'Rust crates', detail: "the app's native code" },
  'CEF-LICENSE.txt': { label: 'Chromium Embedded Framework', detail: 'CEF' },
  'DICTIONARY-en-US-LICENSE.txt': { label: 'Spell-check dictionary', detail: 'English (US), from SCOWL' },
};
const ORDER = Object.keys(KNOWN);
const url = (name: string) => new URL(`licenses/${name}`, document.baseURI).href;

type Index = { name: string; size: number }[];

/** Help > About GitBolt > Open source licenses: the notices bundled with the UI, one at a time. */
export default function Licenses() {
  const [files, setFiles] = useState<Index | null | 'missing'>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(url('index.json'))
      .then((r) => (r.ok ? (r.json() as Promise<{ files: Index }>) : Promise.reject(new Error(String(r.status)))))
      .then(({ files }) => {
        if (!live) return;
        const sorted = [...files].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
        setFiles(sorted);
        setCurrent(sorted[0]?.name ?? null);
      })
      .catch(() => live && setFiles('missing'));
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!current) return;
    let live = true;
    setText(null);
    fetch(url(current))
      // A missing asset comes back as the app's index.html (the asset protocol's fallback), not a 404.
      .then((r) => (r.ok && !(r.headers.get('content-type') ?? '').includes('text/html') ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => live && setText(t))
      .catch(() => live && setText(`Couldn't load ${current}.`));
    return () => { live = false; };
  }, [current]);

  if (files === 'missing') {
    return <p className="licenses-missing">This build doesn&apos;t include the license notices: the production build (and <code>just package</code>) generates them.</p>;
  }
  if (!files) return <p aria-busy="true">Loading…</p>;
  return (
    <div className="licenses">
      <div className="licenses-side">
        <ul className="licenses-list" aria-label="License files">
          {files.map((f) => (
            <li key={f.name}>
              <button type="button" aria-current={f.name === current} onClick={() => setCurrent(f.name)}>
                <span className="licenses-label">{KNOWN[f.name]?.label ?? f.name}</span>
                {KNOWN[f.name] && <span className="licenses-detail">{KNOWN[f.name].detail}</span>}
              </button>
            </li>
          ))}
        </ul>
        {osKind() === 'windows' ? (
          <p className="licenses-note">
            Chromium&apos;s own credits are installed with GitBolt, gzipped (extract them to open in a browser), in its install folder:
            <code>licenses\CHROMIUM-CREDITS.html.gz</code>
          </p>
        ) : osKind() === 'macos' ? (
          <p className="licenses-note">
            Chromium&apos;s own credits are inside the app, gzipped (view them with `zcat` or extract them to open in a browser):
            <code>GitBolt.app/Contents/Resources/licenses/CHROMIUM-CREDITS.html.gz</code>
          </p>
        ) : (
          <p className="licenses-note">
            Chromium&apos;s own credits are installed with the package, gzipped (view them with `zcat` or extract them to open in a browser):
            <code>/usr/share/doc/gitbolt/CHROMIUM-CREDITS.html.gz</code>
          </p>
        )}
      </div>
      <pre className="licenses-text" tabIndex={0} aria-label={current ?? 'License text'} aria-busy={text === null}>{text ?? ''}</pre>
    </div>
  );
}

function rank(name: string): number {
  const i = ORDER.indexOf(name);
  return i < 0 ? ORDER.length : i;
}
