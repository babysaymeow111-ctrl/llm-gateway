// Шлюз к открытым языковым моделям в формате OpenAI API.
// Покупатель активирует код пополнения (Plati, GGSel) и получает ключ sk-… с рублёвым балансом.
// Запросы уходят поставщику (по умолчанию ProxyAPI), с баланса списывается стоимость по факту.
//
// Переменные окружения:
//   UPSTREAM_KEY    — ключ поставщика (обязательно)
//   UPSTREAM_BASE   — адрес API поставщика, по умолчанию https://api.proxyapi.ru/v1
//   MARKUP          — наценка к ценам поставщика, по умолчанию 1.35
//   DB_PATH         — файл базы, по умолчанию data/gateway.db
//   PORT, PUBLIC_URL, BRAND
//   SELLER_NAME, SELLER_INN, CONTACT_EMAIL, HOSTING_NAME, UPSTREAM_NAME — для оферты и политики (legal.js)
//   ADMIN_TOKEN     — включает /admin/* (выпуск кодов, статистика) для хостинга без доступа к консоли
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { open, RUB } = require('./db');
const { createGateway } = require('./gateway');
const { publicModels } = require('./models');
const legal = require('./legal');

const PORT = Number(process.env.PORT || 8790);
const UPSTREAM_BASE = process.env.UPSTREAM_BASE || 'https://api.proxyapi.ru/v1';
const UPSTREAM_KEY = String(process.env.UPSTREAM_KEY || '').trim();
const MARKUP = Number(process.env.MARKUP || 1.35);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data/gateway.db');
const BRAND = process.env.BRAND || 'Шлюз';
const API_BODY_LIMIT = 20 * 1024 * 1024;

if (!UPSTREAM_KEY) throw new Error('UPSTREAM_KEY не задан');
if (!(MARKUP >= 1)) throw new Error('MARKUP должна быть не меньше 1');

const store = open(DB_PATH);
const gateway = createGateway({ store, upstreamBase: UPSTREAM_BASE, upstreamKey: UPSTREAM_KEY, markup: MARKUP });

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const INDEX = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8')
  .replace(/\{\{API_BASE\}\}/g, '')
  .replace('{{MODELS_JSON}}', () => JSON.stringify(publicModels(MARKUP)).replace(/</g, '\\u003c'))
  .replace(/\{\{BRAND\}\}/g, esc(BRAND))
  .replace(/\{\{CONTACT_EMAIL\}\}/g, esc(process.env.CONTACT_EMAIL || ''));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Api-Key',
  'Access-Control-Max-Age': '86400',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function apiError(res, status, message, code) {
  sendJson(res, status, { error: { message, type: status === 401 ? 'authentication_error' : 'invalid_request_error', param: null, code } });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return (m ? m[1] : String(req.headers['x-api-key'] || '')).trim();
}
function authKey(req, res) {
  const token = bearer(req);
  if (!token) { apiError(res, 401, 'Нужен ключ: заголовок Authorization: Bearer sk-…', 'missing_api_key'); return null; }
  const key = store.findKey(token);
  if (!key) { apiError(res, 401, 'Неверный ключ', 'invalid_api_key'); return null; }
  if (key.disabled) { apiError(res, 403, 'Ключ отключён. Напишите в поддержку.', 'key_disabled'); return null; }
  return key;
}

// Перебор кодов: не больше 10 попыток активации в минуту с одного IP (IP нигде не сохраняется)
const redeemTries = new Map();
function redeemAllowed(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const t = Date.now();
  const w = redeemTries.get(ip);
  if (!w || t - w.start > 60_000) { redeemTries.set(ip, { start: t, count: 1 }); return true; }
  return ++w.count <= 10;
}
setInterval(() => {
  const t = Date.now();
  for (const [ip, w] of redeemTries) if (t - w.start > 60_000) redeemTries.delete(ip);
}, 60_000).unref();

const rub = micro => Math.round(micro / RUB * 100) / 100;

// ---------- администрирование по HTTP (то же, что tools/admin.js) ----------
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
if (ADMIN_TOKEN && ADMIN_TOKEN.length < 32) throw new Error('ADMIN_TOKEN должен быть не короче 32 символов');
function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const a = crypto.createHash('sha256').update(bearer(req)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}
async function handleAdmin(req, res, p) {
  if (!isAdmin(req)) { res.writeHead(404); return res.end(); }
  const body = req.method === 'POST' ? JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') : {};
  if (req.method === 'GET' && p === '/admin/stats') return sendJson(res, 200, store.stats());
  if (req.method === 'POST' && p === '/admin/codes') {
    const amount = Number(body.rub), count = Number(body.count);
    if (!(amount > 0) || !Number.isInteger(count) || count < 1 || count > 1000) return apiError(res, 400, 'Нужны rub > 0 и count от 1 до 1000', 'bad_params');
    const batch = body.batch || `${amount}rub-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36).slice(-4)}`;
    const codes = store.addCodes(count, Math.round(amount * RUB), batch);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Batch': encodeURIComponent(batch) });
    return res.end(codes.join('\n') + '\n');
  }
  if (req.method === 'POST' && p === '/admin/recover') {
    const r = store.recover(body.code);
    return r.ok ? sendJson(res, 200, { key: r.key, moved_rub: rub(r.amount), old_key_id: r.oldKeyId }) : apiError(res, 404, r.reason, r.reason);
  }
  if (req.method === 'POST' && p === '/admin/topup') {
    if (!store.keyById(Number(body.key_id)) || !(Number(body.rub) > 0)) return apiError(res, 400, 'Нужны key_id и rub > 0', 'bad_params');
    store.topup(Number(body.key_id), Math.round(Number(body.rub) * RUB), 'admin', body.note || null);
    return sendJson(res, 200, { balance_rub: rub(store.keyById(Number(body.key_id)).balance) });
  }
  if (req.method === 'POST' && p === '/admin/disable') {
    if (!store.keyById(Number(body.key_id))) return apiError(res, 404, 'Ключ не найден', 'not_found');
    store.setDisabled(Number(body.key_id), body.disabled !== false);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && p === '/admin/key') {
    const hint = new URL(req.url, 'http://x').searchParams.get('hint') || '';
    return sendJson(res, 200, store.keysByHint(hint).map(k => ({ id: k.id, hint: k.hint, balance_rub: rub(k.balance), disabled: !!k.disabled })));
  }
  res.writeHead(404); res.end();
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p.startsWith('/v1/') || p.startsWith('/api/')) {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  if (req.method === 'GET' && p === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(INDEX);
  }
  if (req.method === 'GET' && p === '/terms') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(legal.terms());
  }
  if (req.method === 'GET' && p === '/privacy') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(legal.privacy());
  }
  if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });
  if (p.startsWith('/admin/')) return handleAdmin(req, res, p);

  if (req.method === 'GET' && p === '/v1/models') return gateway.listModels(res);
  if (req.method === 'GET' && p.startsWith('/v1/models/')) return gateway.getModel(res, decodeURIComponent(p.slice('/v1/models/'.length)));

  if (req.method === 'POST' && p === '/v1/chat/completions') {
    const key = authKey(req, res);
    if (!key) return;
    let raw;
    try { raw = await readBody(req, API_BODY_LIMIT); } catch (e) {
      return apiError(res, e.status || 400, e.status === 413 ? 'Запрос больше 20 МБ' : 'Не удалось прочитать запрос', 'bad_body');
    }
    return gateway.chatCompletions(req, res, raw, key);
  }

  if (req.method === 'POST' && p === '/api/redeem') {
    if (!redeemAllowed(req)) return apiError(res, 429, 'Слишком много попыток. Подождите минуту.', 'too_many_attempts');
    let body;
    try { body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}'); } catch (e) {
      return apiError(res, 400, 'Тело запроса должно быть JSON', 'invalid_json');
    }
    let keyId = null;
    if (body.key) {
      const key = store.findKey(String(body.key).trim());
      if (!key) return apiError(res, 404, 'Ключ для пополнения не найден. Уберите его из формы, чтобы получить новый.', 'invalid_api_key');
      if (key.disabled) return apiError(res, 403, 'Ключ отключён. Напишите в поддержку.', 'key_disabled');
      keyId = key.id;
    }
    const r = store.redeem(body.code, keyId);
    if (!r.ok) {
      return r.reason === 'used'
        ? apiError(res, 409, 'Этот код уже активирован', 'code_used')
        : apiError(res, 404, 'Код не найден. Проверьте, что он введён полностью.', 'code_not_found');
    }
    const k = store.keyById(r.keyId);
    return sendJson(res, 200, { key: r.key || null, key_hint: k.hint, added_rub: rub(r.amount), balance_rub: rub(k.balance) });
  }

  if (req.method === 'GET' && p === '/api/me') {
    const key = authKey(req, res);
    if (!key) return;
    const s = store.summary(key.id);
    return sendJson(res, 200, {
      key_hint: s.key.hint,
      balance_rub: rub(s.key.balance),
      totals: { requests: s.totals.requests, spent_rub: rub(s.totals.spent), prompt_tokens: s.totals.prompt_tokens, completion_tokens: s.totals.completion_tokens },
      usage: s.usage.map(u => ({ ts: u.ts, model: u.model, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, cost_rub: rub(u.cost), estimated: !!u.estimated, status: u.status })),
      topups: s.topups.map(t => ({ ts: t.ts, amount_rub: rub(t.amount), source: t.source })),
    });
  }

  if (p.startsWith('/v1/')) return apiError(res, 404, 'Такого метода нет. Поддерживаются GET /v1/models и POST /v1/chat/completions.', 'not_found');
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Не найдено');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    if (!res.headersSent) apiError(res, 500, 'Внутренняя ошибка', 'internal_error');
    else res.end();
  });
});
server.requestTimeout = 0;      // потоковые ответы моделей бывают долгими
server.headersTimeout = 60_000;
server.listen(PORT, () => console.log(`${BRAND}: http://localhost:${PORT} → ${UPSTREAM_BASE}, наценка ×${MARKUP}`));
