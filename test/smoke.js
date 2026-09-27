// Проверка шлюза целиком: имитация поставщика + настоящий server.js в отдельном процессе.
// Запуск: npm test
const http = require('http');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { open, RUB } = require('../db');
const { MODELS } = require('../models');

const MARKUP = 1.5;
const ADMIN = 'x'.repeat(40);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
const DB_PATH = path.join(tmp, 'test.db');

// ---------- имитация поставщика ----------
let upstreamCalls = 0, lastBody = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const USAGE = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
const upstream = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: MODELS.map(m => ({ id: m.upstream })) }));
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  upstreamCalls++;
  assert.equal(req.headers.authorization, 'Bearer test-upstream', 'шлюз должен ходить с ключом поставщика');
  const body = lastBody = JSON.parse(Buffer.concat(chunks).toString());
  const prompt = body.messages[0].content;
  if (prompt === '__402__') { res.writeHead(402, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"Недостаточно средств на балансе ProxyAPI"}}'); }
  if (prompt === '__400__') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `Model ${body.model} does not support this parameter (ProxyAPI)`, type: 'invalid_request_error' } }));
  }
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Привет мир' }, finish_reason: 'stop' }], usage: USAGE }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const ev = o => res.write('data: ' + JSON.stringify(o) + '\r\n\r\n');
  const base = { id: 'x', object: 'chat.completion.chunk', model: body.model };
  ev({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
  for (const piece of ['Привет', ' мир']) {
    if (prompt === '__slow__') await sleep(300);
    if (res.destroyed) return;
    ev({ ...base, choices: [{ index: 0, delta: { content: piece } }] });
  }
  if (prompt === '__slow__') { await sleep(3000); if (res.destroyed) return; }
  ev({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  if (body.stream_options && body.stream_options.include_usage) ev({ ...base, choices: [], usage: USAGE });
  res.end('data: [DONE]\r\n\r\n');
});

// ---------- помощники ----------
let GW;
const call = (p, opts = {}) => fetch(GW + p, opts);
const chat = (key, payload, extra = {}) => call('/v1/chat/completions', {
  method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload), ...extra,
});
const msg = content => [{ role: 'user', content }];
let _store = null;
const store = () => _store || (_store = open(DB_PATH));
const balance = keyId => store().keyById(keyId).balance;
const price = id => { const m = MODELS.find(x => x.id === id); return [m.price[0] * MARKUP, m.price[1] * MARKUP]; };
const costOf = (id, p, c) => { const [a, b] = price(id); return Math.ceil(p * a + c * b); };

async function run() {
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const s = store();
  const [code100] = s.addCodes(1, 100 * RUB, 'test-100');
  const [codeTiny] = s.addCodes(1, 1000, 'test-tiny');
  const [codeTop] = s.addCodes(1, 50 * RUB, 'test-50');

  const port = 18000 + Math.floor(Math.random() * 2000);
  GW = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
    env: { ...process.env, PORT: String(port), UPSTREAM_BASE: `http://127.0.0.1:${upPort}`, UPSTREAM_KEY: 'test-upstream', MARKUP: String(MARKUP), DB_PATH, ADMIN_TOKEN: ADMIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childErr = '';
  child.stderr.on('data', d => { childErr += d; });
  for (let i = 0; i < 50; i++) { try { await call('/health'); break; } catch (e) { await sleep(100); } }

  const results = [];
  const test = async (name, fn) => {
    try { await fn(); results.push(['ok', name]); }
    catch (e) { results.push(['FAIL', name, e.message]); }
  };

  let key, keyId;

  await test('GET /v1/models — только модели из models.js, цены с наценкой', async () => {
    const r = await (await call('/v1/models')).json();
    assert.deepEqual(r.data.map(m => m.id), MODELS.map(m => m.id));
    const flash = r.data.find(m => m.id === 'deepseek-v4-flash');
    assert.deepEqual([flash.pricing.input, flash.pricing.output], price('deepseek-v4-flash'));
  });

  await test('активация кода выдаёт новый ключ с балансом 100 ₽', async () => {
    const r = await (await call('/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code100.toLowerCase() }) })).json();
    assert.match(r.key, /^sk-/);
    assert.equal(r.balance_rub, 100);
    key = r.key;
    keyId = store().findKey(key).id;
  });

  await test('повторная активация того же кода — 409', async () => {
    const r = await call('/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code100 }) });
    assert.equal(r.status, 409);
  });

  await test('пополнение существующего ключа вторым кодом', async () => {
    const r = await (await call('/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: codeTop, key }) })).json();
    assert.equal(r.key, null);
    assert.equal(r.balance_rub, 150);
  });

  await test('без ключа и с чужим ключом — 401', async () => {
    assert.equal((await call('/v1/chat/completions', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await chat('sk-wrong', { model: 'deepseek-v4-flash', messages: msg('hi') })).status, 401);
  });

  await test('закрытая модель отклоняется без обращения к поставщику', async () => {
    const before = upstreamCalls;
    for (const model of ['openai/gpt-5.5', 'anthropic/claude-sonnet-5', 'google/gemini-3.8-flash', 'deepseek/deepseek-v4-flash']) {
      const r = await chat(key, { model, messages: msg('hi') });
      assert.equal(r.status, 404, model);
    }
    assert.equal(upstreamCalls, before);
  });

  await test('обычный ответ: списание по usage, модель подменена, max_tokens ограничен', async () => {
    const b0 = balance(keyId);
    const r = await chat(key, { model: 'deepseek-v4-flash', messages: msg('Привет'), max_tokens: 999999 });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.model, 'deepseek-v4-flash');
    assert.equal(lastBody.model, 'deepseek/deepseek-v4-flash');
    assert.equal(lastBody.max_tokens, 32768);
    assert.equal(b0 - balance(keyId), costOf('deepseek-v4-flash', 100, 50));
  });

  await test('поток без include_usage: служебный чанк с usage клиенту не отдаётся, списание по usage', async () => {
    const b0 = balance(keyId);
    const r = await chat(key, { model: 'kimi-k2.6', stream: true, messages: msg('Привет') });
    const text = await r.text();
    assert.equal(lastBody.stream_options.include_usage, true);
    assert.ok(!text.includes('"usage"'), 'usage не должен попасть клиенту');
    assert.ok(text.includes('"model":"kimi-k2.6"') && !text.includes('moonshotai/'), 'модель должна быть подменена');
    assert.ok(text.trim().endsWith('data: [DONE]'));
    const content = text.split('\n\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)))
      .map(o => (o.choices[0] && o.choices[0].delta.content) || '').join('');
    assert.equal(content, 'Привет мир');
    assert.equal(b0 - balance(keyId), costOf('kimi-k2.6', 100, 50));
  });

  await test('поток с include_usage: usage клиенту отдаётся', async () => {
    const r = await chat(key, { model: 'glm-5.3', stream: true, stream_options: { include_usage: true }, messages: msg('Привет') });
    assert.ok((await r.text()).includes('"usage"'));
  });

  await test('ошибка баланса у поставщика: клиенту 503, деньги не списаны, поставщик не упомянут', async () => {
    const b0 = balance(keyId);
    const r = await chat(key, { model: 'deepseek-v4-pro', messages: msg('__402__') });
    assert.equal(r.status, 503);
    assert.ok(!/proxyapi/i.test(await r.text()));
    assert.equal(balance(keyId), b0);
  });

  await test('ошибка в запросе: клиенту 400 без названия поставщика и его идентификатора модели', async () => {
    const b0 = balance(keyId);
    const r = await chat(key, { model: 'deepseek-v4-pro', messages: msg('__400__') });
    assert.equal(r.status, 400);
    const t = await r.text();
    assert.ok(!/proxyapi/i.test(t) && !t.includes('deepseek/deepseek-v4-pro') && t.includes('deepseek-v4-pro'), t);
    assert.equal(balance(keyId), b0);
  });

  await test('недостаточно средств — 402 без обращения к поставщику', async () => {
    const r0 = await (await call('/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: codeTiny }) })).json();
    const before = upstreamCalls;
    const r = await chat(r0.key, { model: 'deepseek-v4-pro', messages: msg('Привет') });
    assert.equal(r.status, 402);
    assert.equal(upstreamCalls, before);
  });

  await test('обрыв потока клиентом: списание по оценке, запись помечена, резерв возвращён', async () => {
    const b0 = balance(keyId);
    const ac = new AbortController();
    const r = await chat(key, { model: 'deepseek-v4-flash', stream: true, messages: msg('__slow__') }, { signal: ac.signal });
    const reader = r.body.getReader();
    await reader.read();
    await sleep(800);
    ac.abort();
    await sleep(500);
    const last = store().summary(keyId, 1).usage[0];
    assert.equal(last.estimated, 1);
    const spent = b0 - balance(keyId);
    assert.ok(spent > 0 && spent < 10_000, 'списано ' + spent + ' мкр., резерв должен вернуться');
  });

  await test('восстановление ключа по коду: остаток переносится, старый ключ отключён', async () => {
    const b0 = balance(keyId);
    const r = store().recover(code100);
    assert.ok(r.ok);
    assert.equal(store().keyById(r.keyId).balance, b0);
    assert.equal((await chat(key, { model: 'deepseek-v4-flash', messages: msg('hi') })).status, 403);
    assert.equal((await chat(r.key, { model: 'deepseek-v4-flash', messages: msg('hi') })).status, 200);
  });

  await test('админ по HTTP: без токена 404, с токеном выпускает рабочие коды', async () => {
    assert.equal((await call('/admin/stats')).status, 404);
    assert.equal((await call('/admin/stats', { headers: { Authorization: 'Bearer wrong' } })).status, 404);
    const r = await call('/admin/codes', { method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ rub: 300, count: 2 }) });
    assert.equal(r.status, 200);
    const codes = (await r.text()).trim().split('\n');
    assert.equal(codes.length, 2);
    const red = await (await call('/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: codes[1] }) })).json();
    assert.equal(red.balance_rub, 300);
  });

  await test('оферта и политика открываются', async () => {
    assert.equal((await call('/terms')).status, 200);
    assert.equal((await call('/privacy')).status, 200);
    const home = await (await call('/')).text();
    assert.ok(home.includes('Активировать код'));
  });

  child.kill();
  await new Promise(r => child.once('exit', r));
  upstream.close();
  _store.db.close();
  let failed = 0;
  for (const [st, name, err] of results) {
    console.log(`${st === 'ok' ? '✓' : '✗'} ${name}${err ? '\n    ' + err : ''}`);
    if (st !== 'ok') failed++;
  }
  if (childErr.trim()) console.log('\nstderr шлюза:\n' + childErr.trim().split('\n').filter(l => !/ExperimentalWarning|--trace-warnings/.test(l)).join('\n'));
  console.log(`\n${results.length - failed} из ${results.length} проверок пройдено`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* Windows может держать файл базы ещё пару секунд */ }
  process.exit(failed ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
