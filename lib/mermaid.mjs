/**
 * Рендер ER-диаграммы через открытый API Mermaid (mermaid.ink, без авторизации).
 *
 * Код диаграммы упаковывается в формат "pako" (zlib + base64url) — тот же,
 * что использует Mermaid Live Editor, поэтому одна строка даёт и картинку,
 * и ссылку на редактирование в mermaid.live.
 */
import { deflateSync } from "node:zlib";

const MERMAID_INK = () => process.env.MERMAID_INK_URL || "https://mermaid.ink";
export const TIMEOUT_MS = 8_000;

export function pakoEncode(code) {
  const state = { code, mermaid: { theme: "default" } };
  const raw = deflateSync(Buffer.from(JSON.stringify(state), "utf8"), { level: 9 });
  // base64url с паддингом '=' — как urlsafe_b64encode в Python-версии
  return "pako:" + raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

export function urls(code) {
  const token = pakoEncode(code);
  const base = MERMAID_INK();
  return {
    svg_url: `${base}/svg/${token}`,
    png_url: `${base}/img/${token}?type=png&bgColor=FFFFFF`,
    edit_url: `https://mermaid.live/edit#${token}`,
  };
}

/**
 * Запрашивает SVG у mermaid.ink и возвращает его как data URI.
 * Бросает Error, если сервис недоступен или отклонил диаграмму —
 * фронтенд в этом случае отрисует диаграмму локально через mermaid.js.
 */
export async function renderSvg(code) {
  let svg;
  try {
    const resp = await fetch(urls(code).svg_url, {
      headers: { "User-Agent": "sql-query-generator/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    svg = await resp.text();
  } catch (exc) {
    throw new Error(`mermaid.ink недоступен: ${exc.message}`);
  }
  if (!svg.slice(0, 2000).includes("<svg")) throw new Error("mermaid.ink вернул не SVG");
  return "data:image/svg+xml;base64," + Buffer.from(fixSvgSize(svg), "utf8").toString("base64");
}

/**
 * mermaid.ink отдаёт <svg width="100%"> — внутри <img> такая картинка
 * растягивается на всю ширину. Проставляем реальные размеры из viewBox.
 */
export function fixSvgSize(svg) {
  const rootEnd = svg.indexOf(">");
  let root = svg.slice(0, rootEnd);
  const box = root.match(/viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/);
  if (!box) return svg;
  const [, width, height] = box;
  root = root.replace(/\s(width|height)="[^"]*"/g, "");
  return `${root} width="${width}" height="${height}"` + svg.slice(rootEnd);
}
