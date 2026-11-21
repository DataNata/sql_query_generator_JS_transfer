// Функция Netlify: /api/models. Логика — в lib/handlers.mjs (её же использует dev-server.mjs).
import { models } from "../../lib/handlers.mjs";

export default (req, context) => models(req, { ip: context.ip });

export const config = { path: "/api/models" };
