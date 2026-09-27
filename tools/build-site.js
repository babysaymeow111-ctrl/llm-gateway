// Сборка статического сайта для GitHub Pages: главная, оферта, политика.
// Сам шлюз (API и база) на Pages работать не может — он живёт на сервере, адрес которого
// передаётся в API_BASE_URL. Страница обращается к нему напрямую (CORS на сервере открыт).
// Без API_BASE_URL сайт собирается в режиме «сервер не подключён»: цены видны, формы отключены.
//
// Переменные: API_BASE_URL (https://…), MARKUP (как на сервере, по умолчанию 1.35), BRAND, CONTACT_EMAIL,
//             SELLER_NAME, SELLER_INN, HOSTING_NAME, UPSTREAM_NAME,
//             SITE_DOMAIN (свой домен вместо *.github.io), SITE_DIR (куда собирать, по умолчанию site/)
// Запуск: node --env-file-if-exists=.env tools/build-site.js
process.env.SITE_ON_PAGES = '1';
const fs = require('fs');
const path = require('path');
const legal = require('../legal');
const { publicModels } = require('../models');

const root = path.join(__dirname, '..');
const out = path.resolve(root, process.env.SITE_DIR || 'site');
const api = String(process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
const markup = Number(process.env.MARKUP || 1.35);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

if (api && !/^https:\/\//.test(api) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(api)) {
  console.error('API_BASE_URL должен начинаться с https:// — страница на GitHub Pages открыта по HTTPS, и браузер не пустит её к серверу по http');
  process.exit(1);
}
if (!(markup >= 1)) { console.error('MARKUP должна быть не меньше 1'); process.exit(1); }

const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
  .replace(/\{\{API_BASE\}\}/g, api ? esc(api) : 'offline')
  .replace('{{MODELS_JSON}}', () => JSON.stringify(publicModels(markup)).replace(/</g, '\\u003c'))
  .replace(/\{\{BRAND\}\}/g, esc(process.env.BRAND || 'Шлюз'))
  .replace(/\{\{CONTACT_EMAIL\}\}/g, esc(process.env.CONTACT_EMAIL || ''));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), index);
// GitHub Pages отдаёт terms.html по адресу /terms, поэтому ссылки на сервере и на Pages одинаковые
fs.writeFileSync(path.join(out, 'terms.html'), legal.terms());
fs.writeFileSync(path.join(out, 'privacy.html'), legal.privacy());
fs.writeFileSync(path.join(out, '.nojekyll'), '');
if (process.env.SITE_DOMAIN) fs.writeFileSync(path.join(out, 'CNAME'), process.env.SITE_DOMAIN.trim() + '\n');

console.log(`Сайт собран в ${out}, API: ${api || 'не подключён — формы отключены'}, наценка ×${markup}`);
const missing = ['SELLER_NAME', 'SELLER_INN', 'CONTACT_EMAIL', 'HOSTING_NAME'].filter(k => !String(process.env[k] || '').trim());
if (missing.length) console.warn('В оферте и политике не заполнено: ' + missing.join(', ') + ' — там будут жёлтые пометки');
