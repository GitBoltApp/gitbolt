// The page's dev server (`just site-dev`) with the last demo build (`just demo-build`, dist/demo/)
// at /demo/, as the built site has it.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.txt': 'text/plain', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp',
};

/** The file under `demoDir` for a request path below /demo/, or null (outside it, missing, or not a file). */
export function demoFile(demoDir: string, url: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(url.split('?')[0] || '/');
  } catch {
    return null;
  }
  const root = resolve(demoDir);
  const file = resolve(root, `.${path.startsWith('/') ? path : `/${path}`}`);
  if (!file.startsWith(root + sep)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

export function demoDev(demoDir: string): Plugin {
  return {
    name: 'gitbolt-site-demo-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/demo', (req, res, next) => {
        const file = demoFile(demoDir, req.url ?? '/');
        if (!file) {
          next();
          return;
        }
        res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
  };
}
