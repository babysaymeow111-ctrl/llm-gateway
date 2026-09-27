// Хранилище на встроенном SQLite (node:sqlite), внешних зависимостей нет.
// Деньги храним целыми микрорублями: 1 ₽ = 1 000 000. Тогда стоимость запроса в микрорублях
// равна «токены × цена за 1 млн токенов в рублях» — без дробей и ошибок округления.
// Ключи и коды хранятся только в виде SHA-256: утечка базы не даёт ими воспользоваться.
// Тексты запросов и ответов не сохраняются нигде.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUB = 1_000_000;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Math.floor(Date.now() / 1000);

// Коды пополнения: 16 символов без похожих друг на друга (0/O, 1/I/L), 80 бит случайности
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function makeCode() {
  let s = '';
  const bytes = crypto.randomBytes(16);
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s.match(/.{4}/g).join('-');
}
const normalizeCode = c => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS keys (
      id INTEGER PRIMARY KEY,
      hash TEXT UNIQUE NOT NULL,
      hint TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS codes (
      hash TEXT PRIMARY KEY,
      amount INTEGER NOT NULL,
      batch TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      used_at INTEGER,
      key_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY,
      key_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      cost INTEGER NOT NULL,
      estimated INTEGER NOT NULL DEFAULT 0,
      status INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_key_ts ON usage (key_id, ts);
    CREATE TABLE IF NOT EXISTS topups (
      id INTEGER PRIMARY KEY,
      key_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      source TEXT NOT NULL,
      ref TEXT
    );
  `);

  const q = {
    insertKey: db.prepare('INSERT INTO keys (hash, hint, balance, created_at) VALUES (?, ?, 0, ?)'),
    keyByHash: db.prepare('SELECT * FROM keys WHERE hash = ?'),
    keyById: db.prepare('SELECT * FROM keys WHERE id = ?'),
    keysByHint: db.prepare('SELECT * FROM keys WHERE hint LIKE ? ORDER BY id DESC LIMIT 20'),
    hold: db.prepare('UPDATE keys SET balance = balance - ? WHERE id = ? AND balance >= ? AND disabled = 0'),
    adjust: db.prepare('UPDATE keys SET balance = balance + ? WHERE id = ?'),
    setDisabled: db.prepare('UPDATE keys SET disabled = ? WHERE id = ?'),
    insertUsage: db.prepare(`INSERT INTO usage (key_id, ts, model, prompt_tokens, completion_tokens, cost, estimated, status)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    recentUsage: db.prepare(`SELECT ts, model, prompt_tokens, completion_tokens, cost, estimated, status
                             FROM usage WHERE key_id = ? ORDER BY id DESC LIMIT ?`),
    usageTotals: db.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(cost), 0) AS spent,
                             COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(completion_tokens), 0) AS completion_tokens
                             FROM usage WHERE key_id = ?`),
    insertCode: db.prepare('INSERT INTO codes (hash, amount, batch, created_at) VALUES (?, ?, ?, ?)'),
    codeByHash: db.prepare('SELECT * FROM codes WHERE hash = ?'),
    useCode: db.prepare('UPDATE codes SET used_at = ?, key_id = ? WHERE hash = ? AND used_at IS NULL'),
    insertTopup: db.prepare('INSERT INTO topups (key_id, ts, amount, source, ref) VALUES (?, ?, ?, ?, ?)'),
    recentTopups: db.prepare('SELECT ts, amount, source FROM topups WHERE key_id = ? ORDER BY id DESC LIMIT ?'),
  };

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  function createKey() {
    const key = 'sk-' + crypto.randomBytes(30).toString('base64url');
    const hint = key.slice(0, 7) + '…' + key.slice(-4);
    const { lastInsertRowid } = q.insertKey.run(sha(key), hint, now());
    return { key, id: Number(lastInsertRowid), hint };
  }

  const findKey = key => (key ? q.keyByHash.get(sha(String(key))) : undefined);

  // Блокирует сумму на балансе до конца запроса. false — денег не хватает или ключ отключён.
  const hold = (keyId, amount) => q.hold.run(amount, keyId, amount).changes === 1;
  const adjust = (keyId, delta) => { if (delta) q.adjust.run(delta, keyId); };

  function logUsage(keyId, model, promptTokens, completionTokens, cost, estimated, status) {
    q.insertUsage.run(keyId, now(), model, promptTokens, completionTokens, cost, estimated ? 1 : 0, status);
  }

  // Активация кода. keyId — пополнить существующий ключ; без него создаётся новый.
  // Возвращает { ok, reason?, key?, keyId, amount }.
  function redeem(rawCode, keyId) {
    const hash = sha(normalizeCode(rawCode));
    return tx(() => {
      const code = q.codeByHash.get(hash);
      if (!code) return { ok: false, reason: 'not_found' };
      if (code.used_at) return { ok: false, reason: 'used' };
      let created = null;
      if (!keyId) { created = createKey(); keyId = created.id; }
      if (q.useCode.run(now(), keyId, hash).changes !== 1) throw new Error('code race');
      q.adjust.run(code.amount, keyId);
      q.insertTopup.run(keyId, now(), code.amount, 'code', code.batch);
      return { ok: true, key: created && created.key, keyId, amount: code.amount };
    });
  }

  function addCodes(count, amount, batch) {
    return tx(() => {
      const out = [];
      for (let i = 0; i < count; i++) {
        const code = makeCode();
        q.insertCode.run(sha(normalizeCode(code)), amount, batch, now());
        out.push(code);
      }
      return out;
    });
  }

  // Утерянный ключ: по активированному им коду выпускаем новый ключ, переносим остаток, старый отключаем
  function recover(rawCode) {
    const hash = sha(normalizeCode(rawCode));
    return tx(() => {
      const code = q.codeByHash.get(hash);
      if (!code) return { ok: false, reason: 'not_found' };
      if (!code.key_id) return { ok: false, reason: 'unused' };
      const old = q.keyById.get(code.key_id);
      const created = createKey();
      q.adjust.run(old.balance, created.id);
      q.adjust.run(-old.balance, old.id);
      q.setDisabled.run(1, old.id);
      q.insertTopup.run(created.id, now(), old.balance, 'recover', 'key#' + old.id);
      return { ok: true, key: created.key, keyId: created.id, amount: old.balance, oldKeyId: old.id };
    });
  }

  function topup(keyId, amount, source, ref) {
    tx(() => { q.adjust.run(amount, keyId); q.insertTopup.run(keyId, now(), amount, source, ref || null); });
  }

  function summary(keyId, limit = 50) {
    return {
      key: q.keyById.get(keyId),
      totals: q.usageTotals.get(keyId),
      usage: q.recentUsage.all(keyId, limit),
      topups: q.recentTopups.all(keyId, 20),
    };
  }

  function stats() {
    return {
      keys: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(balance), 0) AS balance FROM keys').get(),
      codes: db.prepare(`SELECT batch, amount, COUNT(*) AS total, COUNT(used_at) AS used
                         FROM codes GROUP BY batch, amount ORDER BY MIN(created_at) DESC`).all(),
      usage30d: db.prepare(`SELECT model, COUNT(*) AS requests, SUM(cost) AS revenue,
                            SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens
                            FROM usage WHERE ts > ? GROUP BY model ORDER BY revenue DESC`).all(now() - 30 * 86400),
    };
  }

  return {
    db, createKey, findKey, hold, adjust, logUsage, redeem, recover, addCodes, topup, summary, stats,
    keyById: id => q.keyById.get(id),
    keysByHint: s => q.keysByHint.all('%' + s + '%'),
    setDisabled: (id, v) => q.setDisabled.run(v ? 1 : 0, id),
  };
}

module.exports = { open, RUB, normalizeCode };
