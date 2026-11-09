import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../src/evaluation-dashboard');
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const namePattern = /^[a-zA-Z0-9_-]{1,100}\.json$/;
const contentTypes = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/status.js': ['status.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };

/** A read-only, loopback-only viewer of explicit synthetic evaluation records. */
export function evaluationDashboard({ recordDir, port = 0 }) {
  const root = path.resolve(recordDir);
  async function readRecord(name) {
    if (!namePattern.test(name)) return null;
    const target = path.join(root, name);
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return null;
      const input = JSON.parse(await fs.readFile(target, 'utf8'));
      if (input?.schema !== 'synthetic-eval-run-v1' || input?.synthetic !== true || !Array.isArray(input.records)) return null;
      return input;
    } catch { return null; }
  }
  const server = createServer(async (req, res) => {
    const address = server.address();
    const expected = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '';
    const origin = req.headers.origin;
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== expected || (origin && origin !== `http://${expected}`)) {
      res.writeHead(403).end(); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    let url;
    try { url = new URL(req.url, `http://${expected}`); } catch { res.writeHead(400).end(); return; }
    if (url.pathname === '/api/runs') {
      let names = [];
      try { names = (await fs.readdir(root)).filter(n => namePattern.test(n)).sort().reverse().slice(0, 500); } catch (error) { if (error.code !== 'ENOENT') { res.writeHead(503).end(); return; } }
      const runs = [];
      for (const name of names) {
        const data = await readRecord(name);
        if (data) runs.push({ id: name.slice(0, -5), started_at: data.started_at ?? null, model: data.model ?? null, records: data.records });
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ runs })); return;
    }
    const asset = contentTypes[url.pathname];
    if (!asset) { res.writeHead(404).end(); return; }
    try { res.writeHead(200, { 'Content-Type': asset[1] }).end(await fs.readFile(path.join(webRoot, asset[0]))); }
    catch { res.writeHead(500).end(); }
  });
  return { server, listen: () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address()); });
  }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const recordDir = process.env.EVAL_RECORD_DIR || path.resolve(here, '../.local-runtime/evaluations/records');
  const port = Number(process.env.EVAL_DASHBOARD_PORT || '0');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid_dashboard_port');
  const app = evaluationDashboard({ recordDir, port });
  const address = await app.listen();
  console.log(`本地合成评测记录：http://127.0.0.1:${address.port}`);
}
