/**
 * Клиенты LLM-провайдеров на встроенном fetch, без SDK.
 *
 * Добавить модель = добавить строку в MODELS. Ключи берутся из переменных
 * окружения (на Netlify — Site settings → Environment variables, локально — файл .env).
 */

// Функция Netlify живёт не дольше ~60 с, поэтому LLM получает 45 с,
// а ещё ~8 с остаётся на рендер диаграммы через mermaid.ink.
export const TIMEOUT_MS = 45_000;
export const MAX_TOKENS = 2500;

const env = (name) => process.env[name] || "";

/** @typedef {{id: string, label: string, provider: string, model: string}} Model */

/** @type {Model[]} */
export const MODELS = [
  { id: "openai:gpt-4.1-mini", label: "OpenAI · GPT-4.1 Mini", provider: "openai", model: "gpt-4.1-mini" },
  { id: "openai:gpt-4.1", label: "OpenAI · GPT-4.1", provider: "openai", model: "gpt-4.1" },
  { id: "anthropic:claude-sonnet-5-5", label: "Anthropic · Claude Sonnet 5.5", provider: "anthropic", model: "claude-sonnet-5-5" },
  { id: "anthropic:claude-haiku-5-5", label: "Anthropic · Claude Haiku 5.5", provider: "anthropic", model: "claude-haiku-5-5" },
  { id: "gemini:gemini-2.5-flash", label: "Google · Gemini 2.5 Flash", provider: "gemini", model: "gemini-2.5-flash" },
  { id: "groq:openai/gpt-oss-120b", label: "Groq · GPT-OSS 120B", provider: "groq", model: "openai/gpt-oss-120b" },
  { id: "groq:qwen/qwen3.8-27b", label: "Groq · Qwen3.8 27B", provider: "groq", model: "qwen/qwen3.8-27b" },
  { id: "yandex:yandexgpt", label: "Yandex · YandexGPT Pro", provider: "yandex", model: "yandexgpt/latest" },
  { id: "openrouter:deepseek/deepseek-chat", label: "OpenRouter · DeepSeek V3", provider: "openrouter", model: "deepseek/deepseek-chat" },
  { id: "ollama:qwen2.5-coder", label: "Ollama · Qwen2.5 Coder", provider: "ollama", model: "qwen2.5-coder" },
  { id: "demo", label: "Демо-режим (без API-ключа)", provider: "demo", model: "demo" },
];

// Переменные окружения, без которых провайдер недоступен.
// Ollama: с серверов Netlify нет доступа к вашему localhost — нужен публичный OLLAMA_BASE_URL.
export const REQUIRED_ENV = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  yandex: ["YANDEX_API_KEY", "YANDEX_FOLDER_ID"],
  openrouter: ["OPENROUTER_API_KEY"],
  ollama: ["OLLAMA_BASE_URL"],
  demo: [],
};

// OpenAI-совместимые эндпоинты /chat/completions: [базовый URL, переменная с ключом]
const OPENAI_COMPATIBLE = {
  openai: () => ["https://api.openai.com/v1", "OPENAI_API_KEY"],
  groq: () => ["https://api.groq.com/openai/v1", "GROQ_API_KEY"],
  openrouter: () => ["https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"],
  ollama: () => [env("OLLAMA_BASE_URL").replace(/\/+$/, ""), null],
};

/** Ошибка обращения к провайдеру (сеть, ключ, лимиты). */
export class LLMError extends Error {}

export function getModel(modelId) {
  const m = MODELS.find((x) => x.id === modelId);
  if (!m) throw new LLMError(`Неизвестная модель: ${modelId}`);
  return m;
}

export const isAvailable = (model) => REQUIRED_ENV[model.provider].every((v) => env(v));

export const listModels = () =>
  MODELS.map((m) => ({ id: m.id, label: m.label, available: isAvailable(m), requires: REQUIRED_ENV[m.provider] }));

async function postJson(url, payload, headers) {
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      // Без явного User-Agent Cloudflare (Groq, OpenRouter) отвечает 403 / error 1010
      headers: { "Content-Type": "application/json", "User-Agent": "sql-query-generator/1.0", ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (exc) {
    if (exc.name === "TimeoutError" || exc.name === "AbortError") {
      throw new LLMError(`Превышено время ожидания ответа (${TIMEOUT_MS / 1000} с)`);
    }
    throw new LLMError(`Провайдер недоступен: ${exc.cause?.message || exc.message}`);
  }
  const text = await resp.text();
  if (!resp.ok) throw new LLMError(`HTTP ${resp.status} от провайдера: ${text.slice(0, 600)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new LLMError(`Провайдер вернул не JSON: ${text.slice(0, 200)}`);
  }
}

/** Отправляет запрос модели и возвращает текст ответа. */
export async function complete(model, system, user, temperature) {
  if (!isAvailable(model)) {
    const missing = REQUIRED_ENV[model.provider].join(", ");
    throw new LLMError(`Не задан ключ для ${model.label}. Задайте переменные окружения: ${missing}`);
  }

  const p = model.provider;
  if (OPENAI_COMPATIBLE[p]) {
    const [base, keyVar] = OPENAI_COMPATIBLE[p]();
    const headers = keyVar ? { Authorization: `Bearer ${env(keyVar)}` } : {};
    const payload = {
      model: model.model,
      temperature,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (["openai", "groq", "ollama"].includes(p)) payload.response_format = { type: "json_object" };
    const data = await postJson(`${base}/chat/completions`, payload, headers);
    return data.choices[0].message.content;
  }

  if (p === "anthropic") {
    const data = await postJson(
      "https://api.anthropic.com/v1/messages",
      { model: model.model, max_tokens: MAX_TOKENS, temperature, system,
        messages: [{ role: "user", content: user }] },
      { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
    );
    return (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
  }

  if (p === "gemini") {
    const data = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.model}:generateContent`,
      { systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature, maxOutputTokens: MAX_TOKENS, responseMimeType: "application/json" } },
      { "x-goog-api-key": env("GEMINI_API_KEY") },
    );
    return data.candidates[0].content.parts.map((part) => part.text || "").join("");
  }

  if (p === "yandex") {
    const folder = env("YANDEX_FOLDER_ID");
    const data = await postJson(
      "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
      { modelUri: `gpt://${folder}/${model.model}`,
        completionOptions: { stream: false, temperature, maxTokens: String(MAX_TOKENS) },
        messages: [{ role: "system", text: system }, { role: "user", text: user }] },
      { Authorization: `Api-Key ${env("YANDEX_API_KEY")}`, "x-folder-id": folder },
    );
    return data.result.alternatives[0].message.text;
  }

  throw new LLMError(`Провайдер ${p} не поддерживается`);
}
