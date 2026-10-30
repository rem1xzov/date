'use strict';
/**
 * Локальный сервер приглашения.
 *  - отдаёт index.html и admin.html
 *  - принимает события от её страницы (POST /api/event) и складывает в data/events.jsonl
 *  - отдаёт админу ленту событий (GET /api/events) и живой поток (GET /api/stream, SSE)
 *
 * Запуск: node server.js  →  http://localhost:8099/  и  http://localhost:8099/admin
 * Порт можно переопределить: $env:PORT=9000; node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const PORT = Number(process.env.PORT) || 8099;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 8 * 1024;          // 8 КБ на событие — больше не нужно
const MAX_EVENTS = 5000;            // сколько событий держим в памяти
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // необязательный пароль админки

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

/* ---------------- хранилище ---------------- */

fs.mkdirSync(DATA_DIR, { recursive: true });

/** @type {Array<object>} */
let events = [];

function loadEvents() {
  if (!fs.existsSync(EVENTS_FILE)) return;
  let raw = '';
  try {
    raw = fs.readFileSync(EVENTS_FILE, 'utf8');
  } catch (e) {
    console.error('[events] не смог прочитать файл:', e.message);
    return;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev === 'object' && ev.id) events.push(ev);
    } catch { /* битую строку пропускаем */ }
  }
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  console.log('[events] загружено из файла:', events.length);
}

function appendEvent(ev) {
  events.push(ev);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  fs.appendFile(EVENTS_FILE, JSON.stringify(ev) + '\n', (err) => {
    if (err) console.error('[events] не смог записать:', err.message);
  });
}

/* ---------------- SSE-подписчики ---------------- */

/** @type {Set<import('http').ServerResponse>} */
const clients = new Set();

function broadcast(ev) {
  const payload = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

/* ---------------- валидация события ---------------- */

const TYPES = new Set(['visit', 'yes', 'no', 'place', 'custom_place', 'when', 'final', 'modal_close']);

function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function buildEvent(body, req) {
  if (!body || typeof body !== 'object') return { error: 'тело должно быть объектом' };
  const type = str(body.type, 32);
  if (!TYPES.has(type)) return { error: 'неизвестный тип события' };

  const ev = {
    id: crypto.randomUUID(),
    type,
    ts: Date.now(),
    session: str(body.session, 64) || 'unknown',
    place: str(body.place, 160),
    when: str(body.when, 120),
    note: str(body.note, 300),
    ua: str(req.headers['user-agent'] || '', 200),
    ip: (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  };
  return { ev };
}

/* ---------------- HTTP ---------------- */

function send(res, code, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  res.writeHead(code, h);
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function serveStatic(res, file) {
  const full = path.join(ROOT, file);
  // защита от выхода за пределы папки проекта
  if (!full.startsWith(ROOT + path.sep)) return send(res, 403, 'forbidden');
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function adminAllowed(req, url) {
  if (!ADMIN_TOKEN) return true;
  const given = url.searchParams.get('token') || req.headers['x-admin-token'] || '';
  return given === ADMIN_TOKEN;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch {
    return send(res, 400, 'bad request');
  }
  const p = url.pathname;

  // --- API ---
  if (p === '/api/event' && req.method === 'POST') {
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return sendJson(res, 413, { ok: false, error: 'слишком большое тело' });
    }
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return sendJson(res, 400, { ok: false, error: 'невалидный JSON' });
    }
    const built = buildEvent(body, req);
    if (built.error) return sendJson(res, 400, { ok: false, error: built.error });

    appendEvent(built.ev);
    broadcast(built.ev);
    console.log('[event]', built.ev.type, built.ev.place || built.ev.when || '');
    return sendJson(res, 200, { ok: true, id: built.ev.id });
  }

  if (p === '/api/events' && req.method === 'GET') {
    if (!adminAllowed(req, url)) return sendJson(res, 401, { ok: false, error: 'нужен токен' });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), MAX_EVENTS);
    return sendJson(res, 200, { ok: true, total: events.length, events: events.slice(-limit) });
  }

  if (p === '/api/stream' && req.method === 'GET') {
    if (!adminAllowed(req, url)) return sendJson(res, 401, { ok: false, error: 'нужен токен' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* закрыт */ }
    }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (p === '/api/reset' && req.method === 'POST') {
    if (!adminAllowed(req, url)) return sendJson(res, 401, { ok: false, error: 'нужен токен' });
    events = [];
    fs.writeFile(EVENTS_FILE, '', (err) => {
      if (err) console.error('[events] не смог очистить:', err.message);
    });
    broadcast({ id: crypto.randomUUID(), type: 'reset', ts: Date.now(), session: 'admin' });
    return sendJson(res, 200, { ok: true });
  }

  if (p.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'нет такого метода' });

  // --- статика ---
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');

  if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
  if (p === '/admin' || p === '/admin/' || p === '/admin.html') return serveStatic(res, 'admin.html');
  if (p === '/favicon.ico') return send(res, 204, '');

  // прочие файлы проекта — только безопасные расширения
  const ext = path.extname(p).toLowerCase();
  if (MIME[ext] && !p.includes('..')) return serveStatic(res, p.replace(/^\/+/, ''));

  return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
});

loadEvents();

server.listen(PORT, HOST, () => {
  console.log('Приглашение:  http://localhost:' + PORT + '/');
  console.log('Админка:      http://localhost:' + PORT + '/admin');
  console.log('События:      ' + EVENTS_FILE);
  if (ADMIN_TOKEN) console.log('Админка защищена токеном (ADMIN_TOKEN).');
});

process.on('SIGINT', () => {
  console.log('\nОстанавливаюсь…');
  for (const res of clients) { try { res.end(); } catch { /* ignore */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
