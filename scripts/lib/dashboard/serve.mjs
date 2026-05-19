/**
 * @fileoverview Minimal localhost static server for the dashboard. Binds
 * `127.0.0.1` only, path-contained to the dashboard directory, validates
 * the `Host` header (DNS-rebinding defence), and sends `no-store` on every
 * response. See docs/plans/local-dashboard.md §7 / §7.1.
 *
 * @module scripts/lib/dashboard/serve
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Open `url` in the default browser, best-effort (never throws). */
function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? 'cmd'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    // A spawn that fails to *execute* the binary emits 'error' asynchronously;
    // an unhandled 'error' on a ChildProcess throws and would crash the
    // server. Swallow it — launching the browser is a best-effort extra.
    child.on('error', () => { /* opener unavailable — ignore */ });
    child.unref();
  } catch { /* synchronous spawn failure — also best-effort */ }
}

/**
 * Serve `dir` over http on `127.0.0.1`.
 *
 * @param {{dir: string, port: number, explicitPort?: boolean, open?: boolean}} opts
 *   `explicitPort` true → fail fast on a busy port (no hopping); false →
 *   try the next port. `open` (default true) → launch the browser.
 * @returns {Promise<{server: http.Server, port: number, url: string}>}
 */
export function serve({ dir, port, explicitPort = false, open = true }) {
  const root = path.resolve(dir);
  const HOST = '127.0.0.1';
  const allowedHosts = new Set();

  const handler = (req, res) => {
    // `no-store` on EVERY response — including early rejections — so no
    // exit path can leak a cacheable response.
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('Expires', '0');

    // DNS-rebinding defence — only our own loopback Host is allowed.
    const host = (req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: bad Host header');
      return;
    }

    let urlPath;
    try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch { res.writeHead(400).end('Bad request'); return; }
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

    // Path containment — resolve, then verify the real path stays in root.
    const resolved = path.resolve(root, '.' + urlPath);
    let real;
    try { real = fs.realpathSync(resolved); }
    catch { res.writeHead(404).end('Not found'); return; }
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: path outside dashboard directory');
      return;
    }
    let body;
    try { body = fs.readFileSync(real); }
    catch { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(real)] || 'application/octet-stream' });
    res.end(body);
  };

  return new Promise((resolve, reject) => {
    let attempt = 0;
    // A FRESH server per attempt — re-listening on an errored server is
    // fragile; this keeps each attempt's listeners isolated.
    const tryListen = (p) => {
      const server = http.createServer(handler);
      server.once('error', (err) => {
        server.close();
        if (err.code === 'EADDRINUSE' && !explicitPort && attempt < 20) {
          attempt += 1;
          tryListen(p + 1);
        } else if (err.code === 'EADDRINUSE') {
          reject(new Error(`port ${p} is in use (pass a free --port, or omit --port to auto-pick)`));
        } else {
          reject(err);
        }
      });
      server.listen(p, HOST, () => {
        // The actual bound port — differs from `p` when `p` is 0 (OS-assigned).
        const actual = server.address().port;
        const url = `http://${HOST}:${actual}`;
        allowedHosts.add(`${HOST}:${actual}`);
        allowedHosts.add(`localhost:${actual}`);
        // First stdout line = machine-readable readiness signal (§7.1).
        process.stdout.write(`DASHBOARD_URL=${url}\n`);
        process.stderr.write(`  [dashboard] serving ${root} at ${url}  (Ctrl+C to stop)\n`);
        if (open) openBrowser(url);
        resolve({ server, port: actual, url });
      });
    };
    tryListen(port);
  });
}
