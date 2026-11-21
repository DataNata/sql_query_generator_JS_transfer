// Функция Netlify: /api/login. Логика — в lib/handlers.mjs (её же использует dev-server.mjs).
import { login } from "../../lib/handlers.mjs";

export default (req, context) => login(req, { ip: context.ip });

export const config = { path: "/api/login" };
