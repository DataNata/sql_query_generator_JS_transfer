// Функция Netlify: /api/logout. Логика — в lib/handlers.mjs (её же использует dev-server.mjs).
import { logout } from "../../lib/handlers.mjs";

export default (req, context) => logout(req, { ip: context.ip });

export const config = { path: "/api/logout" };
