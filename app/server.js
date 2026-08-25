'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const store = require('./lib/store');
const auth = require('./lib/auth');
const { handlers, PUBLIC_ROUTES } = require('./lib/api');
const { HttpError } = require('./lib/util');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 512;

// ---- routing ---------------------------------------------------------

const routes = Object.keys(handlers).map((key) => {
  const sep = key.indexOf(' ');
  const method = key.slice(0, sep);
  const pattern = key.slice(sep + 1);
  const parts = pattern.split('/').filter(Boolean);
  return { key, method, pattern, parts, handler: handlers[key] };
});

function matchRoute(method, pathname) {
  const segments = pathname.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.parts.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < route.parts.length; i++) {
      const p = route.parts[i];
      if (p.startsWith(':')) {
        params[p.slice(1)] = decodeURIComponent(segments[i]);
      } else if (p !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

// ---- helpers ---------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Тело запроса слишком большое'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (err) {
        reject(new HttpError(400, 'Тело запроса должно быть корректным JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  const headers = Object.assign(
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store'
    },
    extraHeaders || {}
  );
  res.writeHead(status, headers);
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const target = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

// ---- request pipeline ------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }
    serveStatic(req, res, pathname);
    return;
  }

  handleApi(req, res, url).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[api]', err);
    if (!res.headersSent) {
      sendJson(res, status, { error: err.message || 'Внутренняя ошибка', details: err.details });
    } else {
      res.end();
    }
  });
});

async function handleApi(req, res, url) {
  const match = matchRoute(req.method, url.pathname);
  if (!match) throw new HttpError(404, 'Метод API не найден');

  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
  const query = Object.fromEntries(url.searchParams.entries());

  const headers = {};
  const ctx = {
    req,
    res,
    body,
    query,
    params: match.params,
    setToken(token) {
      headers['Set-Cookie'] =
        `splitpay_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
    },
    clearToken() {
      headers['Set-Cookie'] = 'splitpay_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
    },
    user: () => {
      throw new HttpError(401, 'Требуется авторизация');
    }
  };

  if (!PUBLIC_ROUTES.has(match.route.key)) {
    const user = auth.requireUser(req);
    ctx.user = () => user;
  }

  const result = await match.route.handler(ctx);
  sendJson(res, 200, result, headers);
}

// ---- lifecycle -------------------------------------------------------

store.data(); // load / create the data file up front

server.listen(PORT, HOST, () => {
  console.log(`SplitPay запущен: http://${HOST}:${PORT}`);
  console.log(`Данные: ${store.DATA_FILE}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: сохраняю данные и завершаю работу...`);
  store.saveOnExit();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = server;
