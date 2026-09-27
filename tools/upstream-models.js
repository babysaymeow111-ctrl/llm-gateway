// Сверка models.js со списком моделей поставщика: какие идентификаторы из models.js у поставщика есть,
// каких нет, и какие ещё модели разрешённых разработчиков он предлагает.
// Запуск: UPSTREAM_KEY=… node tools/upstream-models.js
const { MODELS } = require('../models');

const base = (process.env.UPSTREAM_BASE || 'https://api.proxyapi.ru/v1').replace(/\/$/, '');
const key = String(process.env.UPSTREAM_KEY || '').trim();
if (!key) { console.error('Задайте UPSTREAM_KEY'); process.exit(1); }

// Разработчики, чьи модели можно продавать (см. PROVIDERS в models.js)
const ALLOWED = /deepseek|moonshot|kimi|z-ai|zhipu|glm/i;

(async () => {
  const res = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key } });
  if (!res.ok) { console.error(`Поставщик ответил ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
  const ids = new Set(((await res.json()).data || []).map(m => m.id));

  console.log('Модели из models.js:');
  for (const m of MODELS) console.log(`  ${ids.has(m.upstream) ? 'есть' : 'НЕТ '}  ${m.upstream}  (у нас ${m.id})`);

  const configured = new Set(MODELS.map(m => m.upstream));
  const extra = [...ids].filter(id => ALLOWED.test(id) && !configured.has(id)).sort();
  if (extra.length) {
    console.log('\nЕщё модели разрешённых разработчиков у поставщика (в models.js их нет):');
    for (const id of extra) console.log('  ' + id);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
