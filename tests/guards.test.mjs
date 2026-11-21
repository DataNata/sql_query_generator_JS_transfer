// Запуск: npm test
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as auth from "../lib/auth.mjs";
import * as guards from "../lib/guards.mjs";
import { memoryStore } from "../lib/store.mjs";

const { GuardError } = guards;
const ok = (text) => guards.cleanQuestion(text);
const bad = (text) => assert.throws(() => guards.cleanQuestion(text), GuardError);

describe("Текст запроса", () => {
  test("нормальный запрос, пробелы сжимаются", () =>
    assert.equal(ok("  Показать всех клиентов,\n\n у которых  больше 3 заказов "),
      "Показать всех клиентов, у которых больше 3 заказов"));
  test("большие числа можно", () => ok("Заказы на сумму больше 1000000 рублей"));
  test("пусто, коротко, длинно", () => {
    bad(""); bad("   "); bad("sql"); bad("слово ".repeat(100));
  });
  test("одно слово и без букв", () => {
    bad("Покажиклиентов"); bad("12345 67890 !!!");
  });
  test("повтор символа", () => {
    bad("покажи топ 5 инфойсов по выручке по стране KZ КККККККККК");
    bad("клиенты с заказами !!!!!!");
    ok("клиенты с заказами!!!!!"); // 5 подряд — ещё можно
  });
  test("длинное слово", () => {
    bad("покажи " + "abcd".repeat(10) + "e");
    ok("покажи " + "abcd".repeat(10));
  });
});

describe("SQL только на чтение", () => {
  test("SELECT и WITH", () => {
    guards.checkReadonlySql("SELECT c.name FROM customers c;");
    guards.checkReadonlySql("-- топ\nWITH t AS (SELECT 1 AS x) SELECT x FROM t");
    guards.checkReadonlySql("SELECT updated_at, REPLACE(name, 'a', 'b') FROM t");
  });
  test("слова внутри строк и кавычек не мешают", () => {
    guards.checkReadonlySql("SELECT * FROM log WHERE action = 'DELETE; DROP TABLE x'");
    guards.checkReadonlySql('SELECT "delete" FROM t');
  });
  for (const sql of [
    "DELETE FROM customers",
    "SELECT 1; DROP TABLE customers",
    "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
    "SELECT * INTO backup FROM customers",
    "UPDATE t SET a = 1",
    "",
    "EXPLAIN SELECT 1",
  ]) {
    test(`отклоняется: ${sql || "(пусто)"}`, () => assert.throws(() => guards.checkReadonlySql(sql), GuardError));
  }
});

describe("Лимиты частоты", () => {
  test("в минуту и «один одновременно»", async () => {
    const rl = new guards.RateLimiter({ store: memoryStore(), perMinute: 3, perDay: 100 });
    for (let i = 0; i < 3; i++) {
      await rl.acquire("s");
      await assert.rejects(rl.acquire("s"), (e) => e instanceof GuardError && e.status === 409);
      await rl.release("s");
    }
    await assert.rejects(rl.acquire("s"), (e) => e instanceof GuardError && e.status === 429);
    await rl.acquire("other"); // у другой сессии свой лимит
  });

  test("за сутки", async () => {
    let now = 1000;
    const rl = new guards.RateLimiter({ store: memoryStore(), perMinute: 100, perDay: 2, now: () => now });
    await rl.acquire("s"); await rl.release("s");
    now = 2000;
    await rl.acquire("s"); await rl.release("s");
    await assert.rejects(rl.acquire("s"), GuardError);
    now = 1000 + 86401;
    await rl.acquire("s"); // первый запрос «выпал» из суток
  });

  test("зависшее «занято» снимается само", async () => {
    let now = 1000;
    const rl = new guards.RateLimiter({ store: memoryStore(), now: () => now });
    await rl.acquire("s"); // release не вызван — функция «упала»
    now = 1061;
    await rl.acquire("s");
  });
});

describe("Блокировка входа", () => {
  test("после N ошибок и сброс", async () => {
    const lg = new guards.LoginGuard({ store: memoryStore(), maxFails: 3, lockSec: 60 });
    await lg.fail("1.1.1.1"); await lg.fail("1.1.1.1");
    assert.equal(await lg.lockedUntil("1.1.1.1"), null);
    await lg.fail("1.1.1.1");
    assert.notEqual(await lg.lockedUntil("1.1.1.1"), null);
    assert.equal(await lg.lockedUntil("2.2.2.2"), null);
    await lg.reset("1.1.1.1");
    assert.equal(await lg.lockedUntil("1.1.1.1"), null);
  });
});

describe("Сессии и охранник", () => {
  test("подпись cookie", async () => {
    const token = await auth.createSession("secret");
    assert.ok(await auth.verifySession(token, "secret"));
    assert.equal(await auth.verifySession(token, "other-secret"), null);
    const [id, exp, sig] = token.split(".");
    assert.equal(await auth.verifySession(`${id}.${Number(exp) + 1000}.${sig}`, "secret"), null); // продлить нельзя
    assert.equal(await auth.verifySession("мусор", "secret"), null);
    assert.equal(await auth.verifySession(await auth.createSession("secret", -10), "secret"), null); // истекла
  });

  test("пароль", async () => {
    assert.ok(await auth.checkPassword("01061979", "01061979"));
    assert.ok(!(await auth.checkPassword("0106197", "01061979")));
    assert.ok(!(await auth.checkPassword("", "")));
  });

  test("gate", async () => {
    const secret = auth.sessionSecret("pw", "");
    const token = await auth.createSession(secret);
    assert.deepEqual(await auth.gate("/", null, "pw", ""), { action: "redirect", location: "/login" });
    assert.deepEqual(await auth.gate("/app.js", null, "pw", ""), { action: "redirect", location: "/login" });
    assert.deepEqual(await auth.gate("/api/models", null, "pw", ""), { action: "deny" });
    assert.deepEqual(await auth.gate("/login", null, "pw", ""), { action: "next" });
    assert.deepEqual(await auth.gate("/style.css", null, "pw", ""), { action: "next" });
    assert.deepEqual(await auth.gate("/", token, "pw", ""), { action: "next" });
    assert.deepEqual(await auth.gate("/login", token, "pw", ""), { action: "redirect", location: "/" });
    assert.deepEqual(await auth.gate("/", null, "", ""), { action: "next" }); // без пароля — всё открыто
  });
});
