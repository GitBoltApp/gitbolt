#!/usr/bin/env bash
# The GitHub Pages artefact, site/dist/ (`just site-pages`; .github/workflows/site.yml runs it
# before deploying): the landing page (`just site-build`, which runs the page's own checks), the
# demo under demo/ (`just demo-build`: the WebAssembly graph, then `vite build --mode demo` over the
# bundles in site/demo-data/) and the 404 page, then ui/scripts/check-site.mjs over the result.
# GITVOLT_SITE_BASE is the path the site is served under: / on gitvolt.com. See docs/website.md.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
base=${GITVOLT_SITE_BASE:-/}

# The page (with its own checks, site/build/check.ts), then the demo under demo/; either order works.
just site-build demo-build
# The 404 page is served at any depth, so its links are absolute: under the base.
sed "s|href=\"/|href=\"$base|g" site/404.html > site/dist/404.html
node ui/scripts/check-site.mjs --base "$base" site/dist
