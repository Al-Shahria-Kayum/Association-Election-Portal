const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

// Local-only convenience: production configuration is supplied by api/config.js.
try {
  const environmentLines = fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/);
  for (const line of environmentLines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/config.js') {
    const config = {
      url: process.env.SUPABASE_URL || '',
      publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || ''
    };
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`window.SUPABASE_CONFIG = ${JSON.stringify(config)};`);
    return;
  }

  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(root, `.${requested}`);
  if (!file.startsWith(root) || !types[path.extname(file)]) {
    res.writeHead(404); res.end('Not found'); return;
  }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(4173, () => console.log('CSA DIU portal preview: http://localhost:4173'));
