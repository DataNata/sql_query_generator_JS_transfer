// Edge Function — «охранник» перед всем сайтом.
// Выполняется до выдачи любой страницы или файла: без входа на /login,
// API без входа отвечает 401. Логика — gate() в lib/auth.mjs (её же использует dev-server.mjs).
import { gate, readCookie, SESSION_COOKIE } from "../../lib/auth.mjs";

export default async (request, context) => {
  const env = (name) => Netlify.env.get(name) || "";
  const { pathname } = new URL(request.url);
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  const decision = await gate(pathname, token, env("APP_PASSWORD"), env("SESSION_SECRET"));

  if (decision.action === "deny") {
    return Response.json({ error: "Требуется вход", login: "/login" }, { status: 401 });
  }
  if (decision.action === "redirect") {
    return new Response(null, {
      status: 302,
      headers: { Location: new URL(decision.location, request.url).toString(), "Cache-Control": "no-store" },
    });
  }
  return context.next();
};

export const config = { path: "/*" };
