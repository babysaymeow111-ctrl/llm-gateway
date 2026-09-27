// Список разрешённых моделей. Шлюз пропускает только их: запрос к любой другой модели
// отклоняется с 404 ещё до обращения к поставщику, поэтому закрытые для России модели
// (OpenAI, Anthropic, Google, xAI и т. п.) недоступны, даже если поставщик их отдаёт.
//
// Правило допуска: разработчик модели сам разрешает работу с Россией и встраивание API в свой сервис.
// Модели, которые у поставщика могут обслуживаться американскими или европейскими компаниями
// (gpt-oss, Nemotron, Mistral, Llama, Cohere), не включаем, даже если у них открытые веса.
//
// price — цена поставщика в ₽ за 1 млн токенов [вход, выход]. Наша цена = price × MARKUP.
// upstream — идентификатор модели у поставщика. Сверить с его списком: npm run upstream-models.
// maxOutput — наш потолок выходных токенов на один запрос: ограничивает сумму, которую блокируем на балансе.

const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    terms: 'https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html',
    // Проверено 27.09.2026: п. 3.2 разрешает встраивать модели в свои приложения и сервисы;
    // запрет только для стран под всеобъемлющими санкциями, Россия к ним не относится.
  },
  moonshot: {
    name: 'Moonshot AI (Kimi)',
    terms: 'https://platform.kimi.ai/docs/agreement/modeluse',
    // Проверено 27.09.2026: запрет только для стран под всеобъемлющими санкциями и лиц из санкционных списков.
    // Отдельный договор с Moonshot нужен при выручке сервиса больше $20 млн в год (лицензия Kimi K3).
  },
  zhipu: {
    name: 'Zhipu AI (GLM)',
    terms: 'https://docs.z.ai/legal-agreement/subscription-terms',
    // Проверено 27.09.2026: запрет перепродажи есть только у подписки GLM Coding Plan,
    // для оплаты по факту (pay-as-you-go) ограничений по России и перепродаже не найдено.
  },
};

const MODELS = [
  { id: 'deepseek-v4-pro',      upstream: 'deepseek/deepseek-v4-pro',      provider: 'deepseek', price: [190, 375],        maxOutput: 32768 },
  { id: 'deepseek-v4-flash',    upstream: 'deepseek/deepseek-v4-flash',    provider: 'deepseek', price: [20, 40],          maxOutput: 32768 },
  { id: 'deepseek-v4.1-flash',  upstream: 'deepseek/deepseek-v4.1-flash',  provider: 'deepseek', price: [41.05, 168.42],   maxOutput: 32768 },
  { id: 'deepseek-v3.2',        upstream: 'deepseek/deepseek-v3.2',        provider: 'deepseek', price: [36.84, 53.68],    maxOutput: 16384 },
  { id: 'kimi-k2.6',            upstream: 'moonshotai/kimi-k2.6',          provider: 'moonshot', price: [136.84, 536.84],  maxOutput: 32768 },
  { id: 'kimi-k2.7-code',       upstream: 'moonshotai/kimi-k2.7-code',     provider: 'moonshot', price: [125, 525],        maxOutput: 32768 },
  { id: 'glm-5.3',              upstream: 'z-ai/glm-5.3',                  provider: 'zhipu',    price: [189.47, 600],     maxOutput: 32768 },
  { id: 'glm-5.3-flash',        upstream: 'z-ai/glm-5.3-flash',            provider: 'zhipu',    price: [16.84, 58.95],    maxOutput: 32768 },
  { id: 'glm-4.7',              upstream: 'z-ai/glm-4.7',                  provider: 'zhipu',    price: [53.68, 242.11],   maxOutput: 16384 },
];

for (const m of MODELS) {
  if (!PROVIDERS[m.provider]) throw new Error(`models.js: у модели ${m.id} неизвестный поставщик ${m.provider}`);
}

const byId = new Map(MODELS.map(m => [m.id, m]));

// Описание модели для /v1/models и для таблицы цен на сайте
const CREATED = 1790000000;
function publicModel(m, markup) {
  return {
    id: m.id, object: 'model', created: CREATED, owned_by: PROVIDERS[m.provider].name,
    pricing: { currency: 'RUB', per: '1M tokens', input: +(m.price[0] * markup).toFixed(2), output: +(m.price[1] * markup).toFixed(2) },
    max_output_tokens: m.maxOutput,
  };
}
const publicModels = markup => MODELS.map(m => publicModel(m, markup));

module.exports = { PROVIDERS, MODELS, byId, publicModel, publicModels };
