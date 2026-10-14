# The website

[gitvolt.com](https://gitvolt.com/) is static files on GitHub
Pages: the landing page (`site/`), the live demo (`ui/demo.html`, built with
`vite build --mode demo` over the committed bundles in `site/demo-data/`) and a 404 page. Two
workflows publish it; nothing else does. It loads nothing from other hosts
([PRIVACY.md](../PRIVACY.md#the-website)).

## Deploying

- **Site** (`.github/workflows/site.yml`) runs on a push to main that changes one of:
  `site/`, `ui/src/demo/`, `ui/demo.html`, `ui/build/`, `ui/scripts/check-site.mjs`,
  `ui/vite.config.ts`, `crates/gitvolt-graph/`, `crates/gitvolt-graph-wasm/`,
  `scripts/site-pages.sh`, `.github/workflows/site.yml`, `README.md` (the features),
  `about.toml` (the font license check), `justfile`, `ui/src/security/csp.ts` and
  `crates/gitvolt-app/tauri.conf.json` (the demo page's CSP). It also runs by hand: Actions, Site,
  Run workflow.
- **Jobs:** build (`contents: read`) builds the graph's WebAssembly (`just demo-wasm`), the
  landing page and the demo, and checks them (`just site-pages`, below), then uploads the
  artefact. Deploy publishes it to the `github-pages` environment (main only). Check fetches the
  deployed page, the demo, every bundle (with its `?v=<rev>`: gzip, and the SHA-256's first 12
  digits equal the rev) and the 404 page.
- **App changes elsewhere don't deploy.** The demo shows the UI as of the last deploy; run Site by
  hand to bring it up to date.
- **A demo phase that lands** (methods leave `PENDING`) needs its screenshots in the same push
  (`just site-shots`, committed), or Site stops at the page's check.
- **On another branch,** Run workflow builds and checks without deploying.
- **First run:** compiles the wasm-bindgen CLI and cargo-about; they're cached from main's runs
  after that.

## Downloads

`site/data/release.json` is the release the Downloads section offers. **Site downloads**
(`.github/workflows/site-release.yml`) writes it with `scripts/site-release.py`.

- **When:** a release is published; and by hand (Run workflow on main, with a tag or none).
- **Which release:** the newest by SemVer that isn't a pre-release; the newest pre-release while
  there's no other; or the tag given by hand.
- **What:** each package the release has, found by the names in
  [docs/releasing.md](releasing.md#asset-names-are-an-api), with its size and the SHA-256 from
  the release's `SHA256SUMS`, checked against the digest GitHub reports. A package that isn't in
  `SHA256SUMS` fails the run.
- **Jobs:** read (`contents: read`) picks the release and writes `release.json`; update
  (`contents: write`) commits it to main as github-actions[bot] ("Site: downloads for 0.6.0"),
  when it changed; deploy (`actions: write`) starts Site on main, when it changed. Pull main
  (`git pull --rebase`) before your next push.
- **Fixes apply to later tags.** A release event runs `site-release.yml` as it is at the tag's
  commit, so a fix to the workflow applies to releases tagged after it. For an older tag, run it
  by hand on main.
- **Run it again by hand** after editing a release (its pre-release flag, its assets) or deleting
  one: only publishing starts it.

The format, `schema` 1 (`release` is `null` while there's no published release):

```json
{
  "schema": 1,
  "release": {
    "version": "0.6.0",
    "tag": "v0.6.0",
    "prerelease": false,
    "published": "2026-10-13T03:04:03Z",
    "url": "https://github.com/GitVoltApp/gitvolt/releases/tag/v0.6.0",
    "sums": "https://github.com/GitVoltApp/gitvolt/releases/download/v0.6.0/SHA256SUMS",
    "downloads": [
      {
        "os": "linux",
        "kind": "deb",
        "arch": "x86_64",
        "file": "GitBolt_0.6.0_amd64.deb",
        "url": "https://github.com/GitVoltApp/gitvolt/releases/download/v0.6.0/GitBolt_0.6.0_amd64.deb",
        "bytes": 165800042,
        "sha256": "264c81a9…"
      }
    ]
  }
}
```

`os` is `linux`, `macos` or `windows`; `kind` is `deb`, `rpm`, `arch`, `dmg`, `nsis` or `msi`;
`arch` is `x86_64` or `aarch64`. Downloads come in that order, and only those the release has.

## Caching

GitHub Pages sends every file with `Cache-Control: max-age=600` and has no setting for it.

- **Code** (scripts, stylesheets, the WebAssembly) has content-hashed names, from Vite.
- **The demo's data** is fetched as `manifest.json?v=<rev>` and `<bundle>.gbdemo?v=<rev>`. The
  demo build adds each bundle's `rev` (the first 12 hex digits of its SHA-256) to the manifest it
  publishes, and builds the manifest's own into the demo's code (`ui/build/demoDataRev.ts`).
- **Pages** (`index.html`, `demo/demo.html`) can be up to 10 minutes old after a deploy. New code
  never gets an older cached manifest or bundle. A page loaded before a deploy may get the new
  data, and a part of the demo it hadn't loaded yet may fail to load until the visitor reloads.

## Checking before a push

`just site-pages` builds `site/dist/` as the workflow does and runs `ui/scripts/check-site.mjs`:

- **The page's own checks** (`just site-build`, `site/build/check.ts`): nothing left unfilled, the
  first screen's weight, and a placeholder screenshot only while its scene waits on a demo method
  still pending (`ui/src/demo/coverage.ts`).
- **Pages:** `index.html`, `404.html`, `demo/demo.html` and the demo's manifest are there; no
  dotfile (the upload leaves them out) and no source map.
- **No third-party requests:** every script, stylesheet, image, frame, font and icon a page or
  stylesheet loads is on the site. Links to other sites are fine.
- **Links:** internal links and `#fragments` resolve. The 404 page's links follow
  `GITVOLT_SITE_BASE` (`/` by default; `scripts/site-pages.sh` rewrites them), since Pages
  serves it at any missing path.
- **CSP:** every page has a Content-Security-Policy `<meta>` with no host or scheme source (only
  `'self'`, `'none'`, hashes, nonces, `data:`, `blob:`, `'unsafe-inline'`, `'wasm-unsafe-eval'`),
  and it allows the page's inline `<style>` and `<script>` blocks. Inline styles and `<base href>`
  stay on the site too. After editing `site/404.html`'s styles, update the hash in its CSP
  (the check names the page).
- **The demo's data:** each bundle the manifest lists is there, gzip, with the rev of its bytes;
  no other bundle; the manifest's own rev is in the demo's code; the WebAssembly is gzip under a
  hashed name.
- **Images:** an `<img>` outside the demo has a width and height (no layout shift).
- **No build paths:** no file holds the checkout's path.
- **Budgets** (`BUDGETS` in `ui/scripts/check-site.mjs`):

| What | Budget |
|---|---|
| The demo's bundles | 15 MB |
| The demo's code, at gzip size | 9.1 MB (the app's UI and 3 MB) |
| Binaries Pages sends uncompressed | 1 MB |
| Each image outside the demo | 500 KB |
| The site outside the demo | 10 MB |

To browse it as Pages serves it:

```sh
python3 -m http.server -d site/dist 8000   # http://localhost:8000/
```

## Security

- **Permissions:** each workflow starts with none, and each job asks for what it needs: the build
  `contents: read`; the deploy `pages: write` and `id-token: write`, in the `github-pages`
  environment, from main only, one at a time (concurrency group `pages`); the check none; Site
  downloads as listed under Downloads.
- **Actions** are pinned by commit. No secret but the workflow's own token. Checkouts keep no
  credentials; the downloads commit passes the token to its push alone. No pull-request triggers.
  `scripts/test-workflows.sh` (in `just test`) checks all of this for every workflow.
- **Why a dispatch:** a commit pushed with the workflow's token starts no workflow, so Site
  downloads starts Site through `workflow_dispatch` on main, which the `github-pages` environment
  accepts. A release event runs on its tag, which the environment refuses.

## Setup (once)

1. Settings, Pages, Build and deployment, Source: **GitHub Actions**.
2. Settings, Environments, `github-pages`, Deployment branches and tags: **main** only, no
   required reviewers (they'd hold every deploy).
3. Push main with a change under the paths above, or Actions, Site, Run workflow on main.
4. Optional check: Actions, Site downloads, Run workflow on main, tag empty. It reports
   "release.json is up to date" when the committed file already matches the newest release: no
   commit, no redeploy.
5. Set the domain as under **The domain**, then run Site again: its last step checks the deployed address.

## The domain

The site is at https://gitvolt.com/: Settings, Pages, Custom domain, with Enforce HTTPS (a
deploy from Actions needs no `CNAME` file). The organization's Settings, Pages, Verified domains
holds gitvolt.com, so no other account can claim it. DNS at the registrar: `A` records
185.199.108.153, 185.199.109.153, 185.199.110.153 and 185.199.111.153; `AAAA` records
2606:50c0:8000::153, 2606:50c0:8001::153, 2606:50c0:8002::153 and 2606:50c0:8003::153; `www` a
`CNAME` to gitvoltapp.github.io. gitvoltapp.github.io/gitvolt/ redirects to the domain.

`GITVOLT_SITE_BASE` is the path the site is served under: `/`, the default. To serve it under a
path instead (Pages without the domain: `/gitvolt/`), set it as an `env:` entry on the build job
in `.github/workflows/site.yml`.
