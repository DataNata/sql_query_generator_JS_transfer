/**
 * Обработчики API. Одни и те же для функций Netlify (netlify/functions/*)
 * и для локального сервера (dev-server.mjs).
 *
 *   GET  /api/models    — список моделей и их доступность (есть ли ключ)
 *   POST /api/generate  — {question, model, temperature, dialect}
 *                         → {tables, relationships, sql, explanation, mermaid, diagram, meta}
 *   POST /api/login     — форма входа (password)
 *   GET  /api/logout    — выход
 *
 * Каждый обработчик: (Request, {ip}) → Response.
 */
import * as auth from "./auth.mjs";
import * as generator from "./generator.mjs";
import * as guards from "./guards.mjs";
import * as llm from "./llm.mjs";
import * as mermaid from "./mermaid.mjs";

const env = (name) => process.env[name] || "";
const password = () => env("APP_PASSWORD");
const secret = () => auth.sessionSecret(password(), env("SESSION_SECRET"));

class BadRequest extends Error {}

const json = (status, data, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

const redirect = (location, cookie) => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
};

const isHttps = (req) => new URL(req.url).protocol === "https:";

/** id сессии (или "" без пароля); null — вход не выполнен. */
async function sessionId(req) {
  if (!password()) return "";
  return auth.verifySession(auth.readCookie(req.headers.get("cookie"), auth.SESSION_COOKIE), secret());
}

const unauthorized = () => json(401, { error: "Требуется вход", login: "/login" });

// ---------- /api/models ----------
export async function models(req) {
  if ((await sessionId(req)) === null) return unauthorized();
  return json(200, { models: llm.listModels(), dialects: generator.DIALECTS });
}

// ---------- /api/generate ----------
async function runGeneration(payload) {
  const question = guards.cleanQuestion(payload.question);

  const temperature = Number(payload.temperature ?? 0.2);
  if (!Number.isFinite(temperature)) throw new BadRequest("Температура должна быть числом от 0 до 1");
  const t = Math.min(Math.max(temperature, 0), 1);
  const dialect = Object.hasOwn(generator.DIALECTS, payload.dialect) ? payload.dialect : "postgresql";
  const model = llm.getModel(String(payload.model || "demo"));

  const started = performance.now();
  let raw;
  if (model.provider === "demo") {
    raw = structuredClone(generator.DEMO_RESPONSE);
  } else {
    const [system, user] = generator.buildMessages(question, dialect);
    raw = generator.extractJson(await llm.complete(model, system, user, t));
  }
  const result = generator.normalize(raw);
  guards.checkReadonlySql(result.sql);

  const code = generator.buildMermaid(result);
  const diagram = mermaid.urls(code);
  try {
    diagram.image = await mermaid.renderSvg(code);
  } catch (exc) {
    console.warn("Фолбэк на локальный рендер:", exc.message);
    diagram.image = null;
    diagram.warning = exc.message;
  }

  return {
    ...result,
    mermaid: code,
    diagram,
    meta: {
      model: model.label, temperature: t, dialect: generator.DIALECTS[dialect],
      elapsed_sec: Math.round((performance.now() - started) / 10) / 100,
    },
  };
}

const limiter = new guards.RateLimiter();

export async function generate(req, { ip = "" } = {}) {
  if (req.method !== "POST") return json(405, { error: "Только POST" });
  const sid = await sessionId(req);
  if (sid === null) return unauthorized();
  const key = sid || ip; // лимиты — на сессию (без пароля — на IP)

  const started = performance.now();
  let payload = {};
  let acquired = false;
  let status = "ok", code = 200, body = {};
  try {
    const text = await req.text();
    if (text.length > 16_000) throw new BadRequest("Запрос слишком большой");
    try {
      payload = JSON.parse(text || "{}");
    } catch {
      throw new BadRequest("Некорректный JSON");
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      payload = {};
      throw new BadRequest("Некорректный запрос");
    }
    guards.cleanQuestion(payload.question); // мусор не тратит лимит
    await limiter.acquire(key);
    acquired = true;
    body = await runGeneration(payload);
  } catch (exc) {
    if (exc instanceof guards.GuardError) {
      [status, code] = [`limit: ${exc.message}`, exc.status];
    } else if (exc instanceof BadRequest || exc instanceof generator.LLMResponseError) {
      [status, code] = [`bad: ${exc.message}`, 400];
    } else if (exc instanceof llm.LLMError) {
      console.warn("LLM error:", exc.message);
      [status, code] = [`llm: ${exc.message}`, 502];
    } else {
      console.error("Unexpected error", exc);
      [status, code] = [`error: ${exc.message}`, 500];
    }
    body = { error: code === 500 ? `Внутренняя ошибка: ${exc.message}` : exc.message };
  } finally {
    if (acquired) {
      try { await limiter.release(key); } catch (exc) { console.error("release failed", exc); }
    }
  }
  guards.journal({
    model: String(payload.model || ""), questionLen: String(payload.question ?? "").length,
    status, elapsed: (performance.now() - started) / 1000, ip,
  });
  return json(code, body);
}

// ---------- /api/login, /api/logout ----------
const loginGuard = new guards.LoginGuard();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lockedRedirect = (until) => redirect(`/login?error=locked&until=${Math.ceil(until * 1000)}`);

export async function login(req, { ip = "" } = {}) {
  if (req.method !== "POST") return redirect("/login");
  if (!password()) return redirect("/");
  const form = new URLSearchParams((await req.text()).slice(0, 4000));

  const until = await loginGuard.lockedUntil(ip);
  if (until) return lockedRedirect(until);

  if (await auth.checkPassword(form.get("password") || "", password())) {
    await loginGuard.reset(ip);
    console.log("Вход выполнен:", ip);
    return redirect("/", auth.sessionCookie(await auth.createSession(secret()), isHttps(req)));
  }
  console.warn("Неверный пароль:", ip);
  await loginGuard.fail(ip);
  await sleep(1000); // замедляем перебор
  const lockedNow = await loginGuard.lockedUntil(ip);
  return lockedNow ? lockedRedirect(lockedNow) : redirect("/login?error=wrong");
}

export async function logout(req) {
  return redirect("/login", auth.clearCookie(isHttps(req)));
}
