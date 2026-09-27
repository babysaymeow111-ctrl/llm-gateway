// Прокси /v1/chat/completions к поставщику с оплатой по факту.
//
// Порядок обработки запроса:
//   1. Модель должна быть в models.js — иначе 404 без обращения к поставщику.
//   2. Оцениваем входные токены и ограничиваем выходные тем, что покрывает баланс.
//   3. Блокируем на балансе максимально возможную стоимость (hold), чтобы параллельные
//      запросы не увели баланс в минус.
//   4. После ответа списываем фактическую стоимость по usage поставщика, остаток возвращаем.
//      Если usage не пришёл (обрыв связи), списываем по оценке и помечаем запись estimated.
const { byId, publicModel, publicModels } = require('./models');
const { RUB } = require('./db');

const MIN_OUTPUT = 64;           // меньше этого числа выходных токенов запрос не имеет смысла
const MAX_N = 4;                 // максимум вариантов ответа (параметр n) в одном запросе
const MAX_CONCURRENT = 4;        // одновременных запросов на один ключ
const RPM = 120;                 // запросов в минуту на один ключ
const IMAGE_TOKENS = 2000;       // оценка одной картинки во входе
const UPSTREAM_TIMEOUT = 10 * 60 * 1000;

function createGateway({ store, upstreamBase, upstreamKey, markup, log = console }) {
  const base = upstreamBase.replace(/\/$/, '');
  // Цена в ₽ за 1 млн токенов численно равна цене в микрорублях за один токен
  const priceOf = m => [m.price[0] * markup, m.price[1] * markup];
  const rub = micro => Math.round(micro / RUB * 100) / 100;

  const active = new Map();
  const windows = new Map();

  function send(res, status, obj, headers = {}) {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(obj));
  }
  function error(res, status, message, type, code) {
    send(res, status, { error: { message, type, param: null, code: code || null } });
  }

  function listModels(res) {
    send(res, 200, { object: 'list', data: publicModels(markup) });
  }
  function getModel(res, id) {
    const m = byId.get(id);
    if (!m) return error(res, 404, `Модель «${id}» недоступна. Список моделей: GET /v1/models`, 'invalid_request_error', 'model_not_found');
    send(res, 200, publicModel(m, markup));
  }

  // Грубая оценка входных токенов с запасом: ~3 байта на токен (у кириллицы 4–5, у латиницы ~4)
  function estimateInput(payload) {
    let bytes = 0, images = 0;
    for (const msg of payload.messages || []) {
      bytes += 16;
      const c = msg && msg.content;
      if (typeof c === 'string') bytes += Buffer.byteLength(c);
      else if (Array.isArray(c)) {
        for (const part of c) {
          if (part && part.type === 'text') bytes += Buffer.byteLength(String(part.text || ''));
          else if (part && (part.type === 'image_url' || part.type === 'input_image')) images++;
          else bytes += Buffer.byteLength(JSON.stringify(part || ''));
        }
      }
      if (msg && msg.tool_calls) bytes += Buffer.byteLength(JSON.stringify(msg.tool_calls));
    }
    if (payload.tools) bytes += Buffer.byteLength(JSON.stringify(payload.tools));
    if (payload.response_format) bytes += Buffer.byteLength(JSON.stringify(payload.response_format));
    return Math.ceil(bytes / 3) + images * IMAGE_TOKENS;
  }

  function takeSlot(keyId) {
    const t = Date.now();
    const w = windows.get(keyId);
    if (!w || t - w.start > 60_000) windows.set(keyId, { start: t, count: 1 });
    else if (++w.count > RPM) return 'rpm';
    const n = active.get(keyId) || 0;
    if (n >= MAX_CONCURRENT) return 'concurrency';
    active.set(keyId, n + 1);
    return null;
  }
  function releaseSlot(keyId) {
    const n = (active.get(keyId) || 1) - 1;
    if (n > 0) active.set(keyId, n); else active.delete(keyId);
  }

  async function chatCompletions(req, res, raw, key) {
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch (e) {
      return error(res, 400, 'Тело запроса должно быть JSON', 'invalid_request_error', 'invalid_json');
    }
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.messages)) {
      return error(res, 400, 'Нужно поле messages', 'invalid_request_error', 'missing_messages');
    }
    const model = byId.get(payload.model);
    if (!model) {
      return error(res, 404, `Модель «${payload.model}» недоступна. Список моделей: GET /v1/models`, 'invalid_request_error', 'model_not_found');
    }
    const n = payload.n == null ? 1 : Number(payload.n);
    if (!Number.isInteger(n) || n < 1 || n > MAX_N) {
      return error(res, 400, `Параметр n должен быть от 1 до ${MAX_N}`, 'invalid_request_error', 'invalid_n');
    }

    const busy = takeSlot(key.id);
    if (busy) {
      return error(res, 429, busy === 'rpm'
        ? `Не больше ${RPM} запросов в минуту на ключ`
        : `Не больше ${MAX_CONCURRENT} одновременных запросов на ключ`, 'rate_limit_error', 'rate_limited');
    }

    const [pIn, pOut] = priceOf(model);
    const inputEst = estimateInput(payload);
    const tokenField = payload.max_completion_tokens != null ? 'max_completion_tokens' : 'max_tokens';
    const requested = Number(payload[tokenField]) > 0 ? Math.floor(Number(payload[tokenField])) : model.maxOutput;
    const affordable = Math.floor((key.balance - inputEst * pIn) / (pOut * n));
    const outCap = Math.min(requested, model.maxOutput, affordable);
    if (outCap < MIN_OUTPUT) {
      releaseSlot(key.id);
      return error(res, 402, `Недостаточно средств: баланс ${rub(key.balance)} ₽. Пополните ключ кодом на сайте.`, 'insufficient_quota', 'insufficient_quota');
    }
    const hold = Math.ceil(inputEst * pIn + outCap * n * pOut);
    if (!store.hold(key.id, hold)) {
      releaseSlot(key.id);
      return error(res, 402, 'Недостаточно средств: часть баланса занята текущими запросами', 'insufficient_quota', 'insufficient_quota');
    }

    const stream = payload.stream === true;
    const clientWantsUsage = !!(payload.stream_options && payload.stream_options.include_usage);
    const upstreamBody = { ...payload, model: model.upstream, [tokenField]: outCap };
    if (stream) upstreamBody.stream_options = { ...(payload.stream_options || {}), include_usage: true };

    let settled = false;
    const settle = (usage, outChars, status) => {
      if (settled) return;
      settled = true;
      releaseSlot(key.id);
      if (status >= 400) {
        store.adjust(key.id, hold);
        store.logUsage(key.id, model.id, 0, 0, 0, false, status);
        return;
      }
      const estimated = !(usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens));
      const prompt = estimated ? inputEst : usage.prompt_tokens;
      const completion = estimated ? Math.min(outCap * n, Math.ceil(outChars / 3)) : usage.completion_tokens;
      const cost = Math.ceil(prompt * pIn + completion * pOut);
      store.adjust(key.id, hold - cost);
      store.logUsage(key.id, model.id, prompt, completion, cost, estimated, status);
    };

    const controller = new AbortController();
    let timedOut = false, clientGone = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, UPSTREAM_TIMEOUT);
    res.on('close', () => { if (!res.writableFinished) { clientGone = true; controller.abort(); } });
    // Клиент ушёл, не дождавшись ответа: поставщик вход уже обработал, списываем только его по оценке
    const settleGone = () => settle(null, 0, 200);

    let upstream;
    try {
      upstream = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + upstreamKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (clientGone) return settleGone();
      settle(null, 0, timedOut ? 504 : 502);
      log.error('upstream fetch failed:', e.message);
      return timedOut
        ? error(res, 504, 'Поставщик модели не ответил вовремя. Деньги за запрос не списаны.', 'api_error', 'upstream_timeout')
        : error(res, 502, 'Поставщик модели не ответил. Повторите запрос позже.', 'api_error', 'upstream_unavailable');
    }

    if (!upstream.ok) {
      clearTimeout(timer);
      const text = await upstream.text().catch(() => '');
      settle(null, 0, upstream.status);
      return relayError(res, upstream.status, text, model);
    }

    if (!stream) {
      let json;
      try { json = await upstream.json(); } catch (e) {
        clearTimeout(timer);
        if (clientGone) return settleGone();
        settle(null, 0, 502);
        return error(res, 502, 'Поставщик вернул некорректный ответ', 'api_error', 'bad_upstream_response');
      }
      clearTimeout(timer);
      let outChars = 0;
      for (const c of json.choices || []) outChars += textLength(c.message);
      settle(json.usage, outChars, 200);
      if (json.model) json.model = model.id;
      return send(res, 200, json);
    }

    // Потоковый ответ: пересылаем события SSE по мере прихода, попутно забираем usage
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let usage = null, outChars = 0, buf = '';
    const decoder = new TextDecoder();
    const forward = block => {
      const dataLines = block.split('\n').filter(l => l.startsWith('data:'));
      if (!dataLines.length) return res.write(block + '\n\n');
      const data = dataLines.map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (data === '[DONE]') return res.write('data: [DONE]\n\n');
      let obj;
      try { obj = JSON.parse(data); } catch (e) { return res.write(block + '\n\n'); }
      for (const c of obj.choices || []) outChars += textLength(c.delta);
      if (obj.usage) {
        usage = obj.usage;
        // Клиент не просил usage — служебный чанк без choices ему не отдаём
        if (!clientWantsUsage && (!obj.choices || !obj.choices.length)) return;
      }
      if (obj.model) obj.model = model.id;
      res.write('data: ' + JSON.stringify(obj) + '\n\n');
    };
    try {
      for await (const chunk of upstream.body) {
        buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.trim()) forward(block);
        }
      }
      if (buf.trim()) forward(buf.trim());
      settle(usage, outChars, 200);
      res.end();
    } catch (e) {
      // Обрыв: клиент ушёл или поставщик разорвал соединение. Списываем то, что успели сгенерировать.
      settle(usage, outChars, 200);
      if (!res.writableEnded) res.end();
    } finally {
      clearTimeout(timer);
    }
  }

  // Ошибки поставщика. Всё, что связано с нашим аккаунтом у поставщика (ключ, баланс, доступ),
  // клиенту показываем как временную недоступность и пишем в лог.
  function relayError(res, status, text, model) {
    if (status === 401 || status === 402 || status === 403) {
      log.error(`upstream ${status} for ${model.upstream}:`, text.slice(0, 500));
      return error(res, 503, 'Сервис временно недоступен. Деньги за запрос не списаны.', 'api_error', 'service_unavailable');
    }
    if (status === 429) {
      return error(res, 429, 'Поставщик модели временно ограничил частоту запросов. Повторите позже.', 'rate_limit_error', 'upstream_rate_limited');
    }
    if (status >= 500) {
      log.error(`upstream ${status} for ${model.upstream}:`, text.slice(0, 500));
      return error(res, 502, 'Ошибка на стороне поставщика модели. Деньги за запрос не списаны.', 'api_error', 'upstream_error');
    }
    // 400, 404, 413, 422: ошибка в самом запросе — отдаём как есть, но без упоминания поставщика
    let body;
    try { body = JSON.parse(text); } catch (e) { body = { error: { message: text.slice(0, 1000) || 'Ошибка запроса', type: 'invalid_request_error' } }; }
    const scrubbed = JSON.stringify(body).split(model.upstream).join(model.id).replace(/proxy\s*api/gi, 'provider');
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(scrubbed);
    }
  }

  return { listModels, getModel, chatCompletions, priceOf };
}

function textLength(m) {
  if (!m) return 0;
  let n = 0;
  if (typeof m.content === 'string') n += m.content.length;
  if (typeof m.reasoning_content === 'string') n += m.reasoning_content.length;
  if (typeof m.reasoning === 'string') n += m.reasoning.length;
  if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  return n;
}

module.exports = { createGateway };
