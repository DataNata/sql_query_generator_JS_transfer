// Функция Netlify: /api/generate. Логика — в lib/handlers.mjs (её же использует dev-server.mjs).
import { generate } from "../../lib/handlers.mjs";

export default (req, context) => generate(req, { ip: context.ip });

export const config = { path: "/api/generate" };
