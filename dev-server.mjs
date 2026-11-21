/**
 * Локальный запуск без Netlify CLI:  node dev-server.mjs  →  http://127.0.0.1:8000
 *
 * Повторяет то, что делает Netlify: «охранник» входа (как Edge Function),
 * функции /api/* и раздача файлов из public/. Счётчики лимитов — в памяти.
 * Настройки — из файла .env рядом (уже заданные переменные окружения не перетираются).
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = resolve(ROOT, "public");

// ---------- .env ----------
const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (let line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    process.env[key] ??= value;
  }
}
process.env.SQLGEN_MEMORY_STORE = "1"; // без Netlify Blobs

// Импорт после загрузки .env
const handlers = await import("./lib/handlers.mjs");
const { gate, readCookie, SESSION_COOKIE } = await import("./lib/auth.mjs");

const ROUTES = {
  "/api/models": handlers.models,
  "/api/generate": handlers.generate,
  "/api/login": handlers.login,
  "/api/logout": handlers.logout,
};

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".json": "application/json; charset=utf-8",
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64_000) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function send(res, response) {
  const headers = {};
  response.headers.forEach((value, key) => { if (key !== "set-cookie") headers[key] = value; });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

function staticFile(pathname) {
  // Как на Netlify: "/" → index.html, "/login" → login.html
  const candidates = pathname === "/" ? ["index.html"] : [pathname.slice(1), `${pathname.slice(1)}.html`];
  for (const rel of candidates) {
    const file = resolve(PUBLIC, decodeURIComponent(rel));
    if (!file.startsWith(PUBLIC + sep)) continue;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || "127.0.0.1";
    const url = new URL(req.url, `http://${host}`);
    const ip = req.socket.remoteAddress || "";

    // 1. «Охранник» (на Netlify — Edge Function)
    const decision = await gate(url.pathname, readCookie(req.headers.cookie, SESSION_COOKIE),
      process.env.APP_PASSWORD || "", process.env.SESSION_SECRET || "");
    if (decision.action === "deny") {
      return send(res, Response.json({ error: "Требуется вход", login: "/login" }, { status: 401 }));
    }
    if (decision.action === "redirect") {
      return send(res, new Response(null, { status: 302, headers: { Location: decision.location } }));
    }

    // 2. Функции
    const handler = ROUTES[url.pathname];
    if (handler) {
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
      const request = new Request(url, { method: req.method, headers: req.headers, body });
      return send(res, await handler(request, { ip }));
    }

    // 3. Файлы сайта
    const file = staticFile(url.pathname);
    if (!file) return send(res, new Response("Не найдено", { status: 404 }));
    return send(res, new Response(readFileSync(file), {
      headers: { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" },
    }));
  } catch (exc) {
    console.error(exc);
    if (!res.headersSent) send(res, new Response("Внутренняя ошибка", { status: 500 }));
  }
});

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8000);
server.listen(PORT, HOST, () => {
  console.log(`SQL Query Generator: http://${HOST}:${PORT}`);
  console.log(process.env.APP_PASSWORD ? "Вход по паролю включён (APP_PASSWORD)" : "APP_PASSWORD не задан — вход без пароля");
  if (process.env.APP_PASSWORD && !process.env.SESSION_SECRET) {
    console.log("SESSION_SECRET не задан — подпись сессий производная от пароля (на Netlify задайте SESSION_SECRET)");
  }
});
