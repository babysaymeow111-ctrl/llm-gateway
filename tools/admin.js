// Администрирование из командной строки (на сервере, рядом с базой):
//   node tools/admin.js codes <₽> <кол-во> [партия]  — выпустить коды пополнения, файл для загрузки в Digiseller
//   node tools/admin.js stats                        — ключи, коды, выручка по моделям за 30 дней
//   node tools/admin.js key <часть ключа>            — найти ключ по подсказке sk-xxxx…yyyy
//   node tools/admin.js topup <id ключа> <₽> [заметка]
//   node tools/admin.js disable|enable <id ключа>
//   node tools/admin.js recover <код>                — новый ключ вместо утерянного, остаток переносится
const fs = require('fs');
const path = require('path');
const { open, RUB } = require('../db');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/gateway.db');
const store = open(DB_PATH);
const rub = micro => (micro / RUB).toFixed(2) + ' ₽';
const [cmd, ...args] = process.argv.slice(2);

function die(msg) { console.error(msg); process.exit(1); }

switch (cmd) {
  case 'codes': {
    const amount = Number(args[0]), count = Number(args[1]);
    if (!(amount > 0) || !Number.isInteger(count) || count < 1) die('Использование: codes <₽> <кол-во> [партия]');
    const batch = args[2] || `${amount}rub-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36).slice(-4)}`;
    const codes = store.addCodes(count, Math.round(amount * RUB), batch);
    const dir = path.join(__dirname, '../codes');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, batch + '.txt');
    fs.writeFileSync(file, codes.join('\n') + '\n');
    console.log(`Выпущено ${count} кодов по ${amount} ₽, партия ${batch}`);
    console.log(`Файл для загрузки в Digiseller (один код на строку): ${file}`);
    console.log('Коды в базе хранятся только в виде хеша — не теряйте этот файл, пока не загрузите его.');
    break;
  }
  case 'stats': {
    const s = store.stats();
    console.log(`Ключей: ${s.keys.n}, сумма остатков: ${rub(s.keys.balance)}`);
    console.log('\nКоды:');
    for (const c of s.codes) console.log(`  ${c.batch}: ${rub(c.amount)} × ${c.total}, активировано ${c.used}`);
    console.log('\nРасход за 30 дней:');
    for (const u of s.usage30d) {
      console.log(`  ${u.model}: ${u.requests} запросов, ${rub(u.revenue || 0)}, токены ${u.prompt_tokens} / ${u.completion_tokens}`);
    }
    break;
  }
  case 'key': {
    if (!args[0]) die('Использование: key <часть ключа>');
    for (const k of store.keysByHint(args[0])) {
      const s = store.summary(k.id, 5);
      console.log(`#${k.id} ${k.hint} баланс ${rub(k.balance)}${k.disabled ? ' ОТКЛЮЧЁН' : ''}, запросов ${s.totals.requests}, потрачено ${rub(s.totals.spent)}`);
    }
    break;
  }
  case 'topup': {
    const id = Number(args[0]), amount = Number(args[1]);
    if (!store.keyById(id) || !(amount > 0)) die('Использование: topup <id ключа> <₽> [заметка]');
    store.topup(id, Math.round(amount * RUB), 'admin', args.slice(2).join(' ') || null);
    console.log(`Ключ #${id}: +${amount} ₽, баланс ${rub(store.keyById(id).balance)}`);
    break;
  }
  case 'disable':
  case 'enable': {
    const id = Number(args[0]);
    if (!store.keyById(id)) die(`Использование: ${cmd} <id ключа>`);
    store.setDisabled(id, cmd === 'disable');
    console.log(`Ключ #${id} ${cmd === 'disable' ? 'отключён' : 'включён'}`);
    break;
  }
  case 'recover': {
    if (!args[0]) die('Использование: recover <код>');
    const r = store.recover(args[0]);
    if (!r.ok) die(r.reason === 'unused' ? 'Код ещё не активирован — ключа по нему нет' : 'Код не найден');
    console.log(`Старый ключ #${r.oldKeyId} отключён, перенесено ${rub(r.amount)}.`);
    console.log(`Новый ключ (#${r.keyId}), отправьте покупателю: ${r.key}`);
    break;
  }
  default:
    die('Команды: codes, stats, key, topup, disable, enable, recover. Подробности — в начале tools/admin.js');
}
