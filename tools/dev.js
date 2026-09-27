// Локальный запуск без настоящего поставщика: имитация API моделей + шлюз на отдельной базе data/dev.db.
// При каждом запуске выпускаются три демо-кода по 100 ₽ — они печатаются в консоль.
// Запуск: npm run dev → http://localhost:8790
const http = require('http');
const path = require('path');

const MOCK_PORT = 8791;
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const usage = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 };
  const text = 'Это демо-ответ: шлюз запущен без настоящего поставщика.';
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id: 'dev', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const word of text.split(' ')) {
    res.write('data: ' + JSON.stringify({ id: 'dev', model: body.model, choices: [{ index: 0, delta: { content: word + ' ' } }] }) + '\n\n');
    await new Promise(r => setTimeout(r, 60));
  }
  res.write('data: ' + JSON.stringify({ id: 'dev', model: body.model, choices: [], usage }) + '\n\n');
  res.end('data: [DONE]\n\n');
});

mock.listen(MOCK_PORT, '127.0.0.1', () => {
  process.env.UPSTREAM_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.UPSTREAM_KEY = 'dev';
  process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/dev.db');
  process.env.BRAND = process.env.BRAND || 'Шлюз (демо)';
  const { open, RUB } = require('../db');
  const codes = open(process.env.DB_PATH).addCodes(3, 100 * RUB, 'dev');
  console.log('Демо-коды по 100 ₽:\n  ' + codes.join('\n  '));
  require('../server');
});
