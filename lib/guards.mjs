/**
 * Ограничения сервиса: проверка запроса, лимиты частоты, защита входа, read-only SQL, журнал.
 *
 * Все числа собраны в начале файла — меняйте их здесь.
 * Счётчики лежат в Netlify Blobs (локально — в памяти, см. store.mjs).
 */
import { getSharedStore } from "./store.mjs";

// ---------- Настройки ----------
export const QUESTION_MIN_LEN = 10;   // минимум символов в запросе
export const QUESTION_MAX_LEN = 500;  // максимум (то же значение в public/index.html и public/app.js)
export const QUESTION_MIN_WORDS = 2;  // минимум слов
export const MAX_SAME_CHAR_RUN = 5;   // один символ подряд — не больше 5 раз («ККККК» — уже нет)
export const MAX_WORD_LEN = 40;       // «слово» без пробелов — не длиннее 40 символов

export const RATE_PER_MINUTE = 10;    // генераций в минуту на сессию
export const RATE_PER_DAY = 200;      // генераций за 24 часа на сессию
const BUSY_TTL_SEC = 60;              // «занято» снимается само, если функция упала

export const LOGIN_MAX_FAILS = 5;     // неверных паролей подряд…
export const LOGIN_LOCK_SEC = 15 * 60; // …и вход блокируется на 15 минут

/** Нарушено ограничение; status — HTTP-код ответа. */
export class GuardError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const nowSec = () => Date.now() / 1000;
const safeKey = (s) => encodeURIComponent(String(s)).slice(0, 200);

// ---------- 1. Текст запроса ----------
const SAME_RUN_RE = new RegExp(String.raw`([^\d\s])\1{${MAX_SAME_CHAR_RUN},}`, "u"); // цифры не трогаем: 1000000
const LONG_WORD_RE = new RegExp(String.raw`\S{${MAX_WORD_LEN + 1},}`, "u");
const WORD_RE = /[\p{L}\p{N}]+/gu;

/** Сжимает пробелы и проверяет запрос. Возвращает очищенный текст или бросает GuardError. */
export function cleanQuestion(raw) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new GuardError("Введите запрос пользователя");
  if (text.length > QUESTION_MAX_LEN) {
    throw new GuardError(`Запрос слишком длинный: ${text.length} символов, максимум ${QUESTION_MAX_LEN}`);
  }
  if (text.length < QUESTION_MIN_LEN) throw new GuardError(`Запрос слишком короткий: минимум ${QUESTION_MIN_LEN} символов`);
  if (!/\p{L}/u.test(text)) throw new GuardError("Запрос должен содержать слова, а не только цифры и знаки");
  if ((text.match(WORD_RE) || []).length < QUESTION_MIN_WORDS) {
    throw new GuardError(`Сформулируйте запрос хотя бы из ${QUESTION_MIN_WORDS} слов`);
  }
  const run = text.match(SAME_RUN_RE);
  if (run) {
    throw new GuardError(`Похоже на случайный ввод: символ «${run[1]}» повторяется подряд больше ${MAX_SAME_CHAR_RUN} раз`);
  }
  if (LONG_WORD_RE.test(text)) {
    throw new GuardError(`Похоже на случайный ввод: «слово» длиннее ${MAX_WORD_LEN} символов без пробелов`);
  }
  return text;
}

// ---------- 2. Частота запросов и «один запрос одновременно» ----------
export class RateLimiter {
  constructor({ store = getSharedStore(), perMinute = RATE_PER_MINUTE, perDay = RATE_PER_DAY, now = nowSec } = {}) {
    Object.assign(this, { store, perMinute, perDay, now });
  }

  /** Резервирует слот для генерации; после неё обязательно вызвать release(key). */
  async acquire(key) {
    const k = `rate/${safeKey(key)}`;
    const now = this.now();
    const state = (await this.store.get(k)) || { hits: [], busyUntil: 0 };
    if (state.busyUntil > now) {
      throw new GuardError("Предыдущий запрос ещё выполняется — дождитесь результата", 409);
    }
    const hits = state.hits.filter((t) => t > now - 86400);
    if (hits.length >= this.perDay) {
      throw new GuardError(`Достигнут дневной лимит: ${this.perDay} генераций за 24 часа`, 429);
    }
    const lastMinute = hits.filter((t) => t > now - 60);
    if (lastMinute.length >= this.perMinute) {
      const wait = Math.floor(60 - (now - lastMinute[0])) + 1;
      throw new GuardError(`Слишком часто: не больше ${this.perMinute} генераций в минуту. Повторите через ${wait} с`, 429);
    }
    hits.push(now);
    await this.store.set(k, { hits, busyUntil: now + BUSY_TTL_SEC });
  }

  async release(key) {
    const k = `rate/${safeKey(key)}`;
    const state = await this.store.get(k);
    if (state) await this.store.set(k, { ...state, busyUntil: 0 });
  }
}

// ---------- 3. Блокировка входа после неверных паролей ----------
export class LoginGuard {
  constructor({ store = getSharedStore(), maxFails = LOGIN_MAX_FAILS, lockSec = LOGIN_LOCK_SEC, now = nowSec } = {}) {
    Object.assign(this, { store, maxFails, lockSec, now });
  }

  /** Время окончания блокировки (секунды epoch) или null, если вход разрешён. */
  async lockedUntil(ip) {
    const now = this.now();
    const fails = ((await this.store.get(`login/${safeKey(ip)}`)) || []).filter((t) => t > now - this.lockSec);
    return fails.length >= this.maxFails ? fails[fails.length - 1] + this.lockSec : null;
  }

  async fail(ip) {
    const k = `login/${safeKey(ip)}`;
    const now = this.now();
    const fails = ((await this.store.get(k)) || []).filter((t) => t > now - this.lockSec);
    fails.push(now);
    await this.store.set(k, fails);
  }

  async reset(ip) {
    await this.store.delete(`login/${safeKey(ip)}`);
  }
}

// ---------- 4. SQL только на чтение ----------
const SQL_STRIP_RE = new RegExp([
  String.raw`--[^\n]*`,        // комментарий до конца строки
  String.raw`\/\*[\s\S]*?\*\/`, // блочный комментарий
  String.raw`'(?:[^']|'')*'`,   // строковый литерал
  String.raw`"[^"]*"`,          // идентификатор в двойных кавычках
  "`[^`]*`",                    // идентификатор MySQL
  String.raw`\[[^\]]*\]`,       // идентификатор SQL Server
].join("|"), "g");
const SQL_FORBIDDEN_RE = new RegExp(
  String.raw`\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|ALTER|TRUNCATE|CREATE|RENAME|GRANT|REVOKE|` +
  String.raw`EXEC|EXECUTE|CALL|COPY|ATTACH|DETACH|VACUUM|LOCK|INTO)\b`, "i");

/** Пропускает только один запрос SELECT / WITH без команд изменения данных. */
export function checkReadonlySql(sql) {
  const body = String(sql ?? "").replace(SQL_STRIP_RE, " ").trim().replace(/;+$/, "").trim();
  if (!/^(SELECT|WITH)\b/i.test(body)) {
    throw new GuardError("Модель вернула не SELECT-запрос — результат отклонён. Попробуйте ещё раз", 502);
  }
  if (body.includes(";")) {
    throw new GuardError("Модель вернула несколько SQL-команд — результат отклонён. Попробуйте ещё раз", 502);
  }
  const m = body.match(SQL_FORBIDDEN_RE);
  if (m) {
    throw new GuardError(`В SQL найдена команда ${m[1].toUpperCase()}: разрешено только чтение данных. ` +
      "Результат отклонён, попробуйте ещё раз", 502);
  }
}

// ---------- 5. Журнал запросов (без текста запроса) ----------
// На Netlify строки видны в Logs → Functions, локально — в окне сервера.
export function journal({ model = "", questionLen = 0, status = "", elapsed = 0, ip = "" }) {
  console.log("[journal] " + JSON.stringify({
    ts: new Date().toISOString(), ip, model: model || "-", len: questionLen,
    status: String(status).replace(/\s+/g, " ").slice(0, 200), sec: Number(elapsed.toFixed(2)),
  }));
}
