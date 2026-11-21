/**
 * Вход по паролю без хранения сессий на сервере.
 *
 * После верного пароля выдаётся cookie вида  <id>.<expires>.<подпись>,
 * подпись — HMAC-SHA256 секретом SESSION_SECRET. Подделать её без секрета нельзя,
 * поэтому серверу не нужно помнить сессии.
 *
 * Модуль работает и в функциях Netlify (Node), и в Edge Function (Deno):
 * только Web Crypto, без node:-модулей и без process.env — настройки передаются параметрами.
 */

export const SESSION_COOKIE = "sqlgen_session";
export const SESSION_TTL_SEC = 12 * 3600; // сессия живёт 12 часов

// Доступно без входа
const PUBLIC_PATHS = new Set(["/login", "/login.html", "/style.css", "/favicon.ico", "/api/login", "/api/logout"]);

const enc = new TextEncoder();

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Секрет подписи: SESSION_SECRET, а если не задан — производный от пароля (смена пароля = выход всех). */
export const sessionSecret = (password, secret) => secret || `sqlgen-fallback:${password}`;

const hmacKey = (secret) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function createSession(secret, ttlSec = SESSION_TTL_SEC) {
  const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${id}.${exp}`)));
  return `${id}.${exp}.${b64url(sig)}`;
}

/** Возвращает id сессии, если cookie подлинная и не истекла, иначе null. */
export async function verifySession(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(`${id}.${exp}`));
    return ok ? id : null;
  } catch {
    return null;
  }
}

/** Сравнение пароля за постоянное время (через SHA-256 обеих строк). */
export async function checkPassword(value, password) {
  if (!password) return false;
  const [a, b] = await Promise.all([value, password].map(async (s) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s ?? ""))))));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token, secure) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SEC}` +
    (secure ? "; Secure" : "");
}

export const clearCookie = (secure) =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` + (secure ? "; Secure" : "");

/**
 * Решение «охранника» для любого адреса сайта (Edge Function и локальный dev-server):
 *   {action: "next"}                — пропустить
 *   {action: "deny"}                — API без входа → 401
 *   {action: "redirect", location}  — перенаправить
 */
export async function gate(pathname, token, password, secret) {
  if (!password) return { action: "next" };
  const valid = await verifySession(token, sessionSecret(password, secret));
  const isLogin = pathname === "/login" || pathname === "/login.html";
  if (valid) return isLogin ? { action: "redirect", location: "/" } : { action: "next" };
  if (PUBLIC_PATHS.has(pathname)) return { action: "next" };
  if (pathname.startsWith("/api/")) return { action: "deny" };
  return { action: "redirect", location: "/login" };
}
