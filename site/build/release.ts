// The downloads (spec §6.1 item 6, §7): site/data/release.json, in plan 6's format (schema 1,
// written by scripts/site-release.py when a release is published), rendered into the page at build
// time. The visitor's platform goes first in the browser (src/downloads.ts). Node-side only.
import { readFileSync } from 'node:fs';
import { esc, type Marker } from './page.ts';

export type Os = 'linux' | 'macos' | 'windows';
export type Kind = 'deb' | 'rpm' | 'arch' | 'dmg' | 'nsis' | 'msi';
export interface Download { os: Os; kind: Kind; arch: 'x86_64' | 'aarch64'; file: string; url: string; bytes: number; sha256: string }
export interface Release { version: string; tag: string; prerelease: boolean; published: string; url: string; sums: string; downloads: Download[] }
export interface ReleaseFile { schema: 1; release: Release | null }

const RELEASES = 'https://github.com/GitVoltApp/gitvolt/releases';
const OSES: Os[] = ['linux', 'macos', 'windows'];
const KINDS: Kind[] = ['deb', 'rpm', 'arch', 'dmg', 'nsis', 'msi'];

/** `value` as release.json's content, or an error saying what's wrong with it. */
export function checkRelease(value: unknown): ReleaseFile {
  const f = value as ReleaseFile;
  if (f?.schema !== 1) throw new Error(`release.json: schema ${JSON.stringify(f?.schema)}, want 1 (plan 6's scripts/site-release.py)`);
  if (f.release === null) return { schema: 1, release: null };
  const r = f.release;
  if (typeof r?.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9a-z.]+)?$/.test(r.version)) throw new Error(`release.json: bad version ${JSON.stringify(r?.version)}`);
  if (r.tag !== `v${r.version}`) throw new Error(`release.json: tag ${JSON.stringify(r.tag)} isn't v${r.version}`);
  if (typeof r.prerelease !== 'boolean') throw new Error('release.json: prerelease must be true or false');
  if (typeof r.published !== 'string' || Number.isNaN(Date.parse(r.published))) throw new Error('release.json: bad published date');
  if (r.url !== `${RELEASES}/tag/${r.tag}`) throw new Error(`release.json: url ${JSON.stringify(r.url)} isn't ${r.tag}'s release page`);
  if (r.sums !== `${RELEASES}/download/${r.tag}/SHA256SUMS`) throw new Error(`release.json: sums ${JSON.stringify(r.sums)} isn't ${r.tag}'s SHA256SUMS`);
  if (!Array.isArray(r.downloads)) throw new Error('release.json: no downloads');
  for (const d of r.downloads) {
    if (!OSES.includes(d.os)) throw new Error(`release.json: ${d.file}: bad os ${JSON.stringify(d.os)}`);
    if (!KINDS.includes(d.kind)) throw new Error(`release.json: ${d.file}: bad kind ${JSON.stringify(d.kind)}`);
    if (d.arch !== 'x86_64' && d.arch !== 'aarch64') throw new Error(`release.json: ${d.file}: bad arch ${JSON.stringify(d.arch)}`);
    if (typeof d.file !== 'string' || d.url !== `${RELEASES}/download/${r.tag}/${d.file}`) throw new Error(`release.json: ${JSON.stringify(d.url)} is not a download of ${r.tag}`);
    if (!Number.isInteger(d.bytes) || d.bytes < 0) throw new Error(`release.json: ${d.file}: bad bytes`);
    if (!/^[0-9a-f]{64}$/.test(d.sha256)) throw new Error(`release.json: ${d.file}: bad sha256`);
  }
  return {
    schema: 1,
    release: {
      version: r.version, tag: r.tag, prerelease: r.prerelease, published: r.published, url: r.url, sums: r.sums,
      downloads: r.downloads.map((d) => ({ os: d.os, kind: d.kind, arch: d.arch, file: d.file, url: d.url, bytes: d.bytes, sha256: d.sha256 })),
    },
  };
}

const LABEL: Record<Kind, [label: string, ext: string]> = {
  deb: ['Debian, Ubuntu', '.deb'],
  rpm: ['Fedora 40+, openSUSE', '.rpm'],
  arch: ['Arch Linux', 'Arch'],
  dmg: ['Disk image', '.dmg'],
  nsis: ['Installer, for you', '.exe'],
  msi: ['MSI, for all users', '.msi'],
};
const label = (d: Download) => (d.kind === 'dmg' && d.arch === 'x86_64' ? 'Disk image, Intel' : LABEL[d.kind][0]);

const ICONS: Record<Os, string> = {
  linux: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2c-2.2 0-3.6 1.9-3.6 4.6 0 1.4.3 2.3.1 3.3-.3 1.4-1.7 2.5-2.6 4.1-.9 1.7-1.2 3.6-.4 4.6.6.8 1.6.7 2.4 1.1.9.5 1.4 1.9 2.7 1.9 1 0 1.3-.7 1.4-.7s.4.7 1.4.7c1.3 0 1.8-1.4 2.7-1.9.8-.4 1.8-.3 2.4-1.1.8-1-.5-2.9-1.4-4.6-.9-1.6-2.3-2.7-2.6-4.1-.2-1 .1-1.9.1-3.3C15.6 3.9 14.2 2 12 2Zm-1.6 4.3c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1Zm3.2 0c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1ZM12 9.2c.8 0 1.8.5 1.8.9 0 .4-1 1.1-1.8 1.1s-1.8-.7-1.8-1.1c0-.4 1-.9 1.8-.9Z"/></svg>',
  macos: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.4 2-3.5 2-3.6-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.9-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.6s-2.5-1-2.5-3.7ZM14.1 5.5c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1 .1 2.1-.5 2.7-1.3Z"/></svg>',
  windows: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 5.1 10.4 4v7.2H3V5.1Zm0 13.8 7.4 1.1v-7.1H3v6Zm8.2 1.2L21 21.5v-8.6h-9.8v7.2Zm0-16.2v7.3H21V2.5l-9.8 1.4Z"/></svg>',
};

/** The cards in the approved design's order; the page's script moves the visitor's first. */
const PLATFORMS: Array<{ os: Os; name: string; detail: (d: Download[]) => string; lane: string; note: string }> = [
  { os: 'linux', name: 'Linux', detail: () => 'x86-64', lane: 'teal', note: 'Updates install through your package manager, with <code>pkexec</code>.' },
  {
    os: 'macos', name: 'macOS', lane: 'magenta',
    detail: (d) => (d.some((x) => x.arch === 'x86_64') ? '12 or later' : '12 or later, Apple Silicon'),
    note: 'Ad-hoc signed, not notarized: the first launch asks you to allow it in System Settings › Privacy &amp; Security.',
  },
  { os: 'windows', name: 'Windows', detail: () => '10 and 11, x64', lane: 'blue', note: 'Not code-signed yet: SmartScreen warns once, <b>More info</b> › <b>Run anyway</b>.' },
];

export function renderDownloads(f: ReleaseFile): string {
  const r = f.release;
  if (!r) return `<p class="dfoot">No release yet: see <a href="${RELEASES}">the releases page</a>.</p>`;
  const cards = PLATFORMS.map((p) => {
    const files = r.downloads.filter((d) => d.os === p.os);
    const buttons = files
      .map((d, i) => `<a class="fbtn${i === 0 ? ' primary' : ''}" href="${esc(d.url)}"><span><b>${esc(label(d))}</b><code>${esc(d.file)}</code></span><em>${LABEL[d.kind][1]}</em><i aria-hidden="true">↓</i></a>`)
      .join('');
    const body = files.length ? `${buttons}\n  <p class="note">${p.note}</p>` : `<p class="none">Not in this release: see <a href="${esc(r.url)}">the release page</a>.</p>`;
    const sums = files.map((d) => `<code>${esc(d.sha256)}  ${esc(d.file)}</code>`).join('');
    return `<div class="glass dl l-${p.lane}" data-os="${p.os}">
  <div class="dlh"><span class="osg">${ICONS[p.os]}</span><div><h3>${p.name}</h3><p>${p.detail(files)}</p></div><span class="youtag" hidden>Your system</span></div>
  ${body}${sums ? `\n  <details class="sums"><summary>SHA-256</summary>${sums}</details>` : ''}
</div>`;
  }).join('');
  const version = `Version ${esc(r.version)}${r.prerelease ? ', a pre-release' : ''}.`;
  return `<div class="dgrid">${cards}</div>
<p class="dfoot">${version} Needs Git 2.40 or newer on your <code>PATH</code>. <a href="${esc(r.sums)}"><code>SHA256SUMS</code></a> lists each file's checksum. After that, GitVolt updates itself.</p>`;
}

export function releaseMarker(path: string): Marker {
  return (arg) => {
    const f = checkRelease(JSON.parse(readFileSync(path, 'utf8')));
    if (arg === 'version') return f.release ? esc(f.release.version) : '';
    if (arg === 'downloads') return renderDownloads(f);
    throw new Error(`index.html: unknown <!--release:${arg}-->`);
  };
}
