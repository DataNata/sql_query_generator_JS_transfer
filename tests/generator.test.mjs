// Запуск: npm test
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { describe, test } from "node:test";

import * as generator from "../lib/generator.mjs";
import * as mermaid from "../lib/mermaid.mjs";

describe("extractJson", () => {
  test("обычный JSON", () => assert.deepEqual(generator.extractJson('{"a": 1}'), { a: 1 }));
  test("в markdown-блоке", () => assert.deepEqual(generator.extractJson('```json\n{"a": 1}\n```'), { a: 1 }));
  test("с текстом вокруг", () =>
    assert.deepEqual(generator.extractJson('Вот ответ: {"a": {"b": 2}} Готово.'), { a: { b: 2 } }));
  test("пустой ответ", () => assert.throws(() => generator.extractJson("  "), generator.LLMResponseError));
});

describe("normalize", () => {
  test("демо-ответ корректен", () => {
    const result = generator.normalize(generator.DEMO_RESPONSE);
    assert.deepEqual(result.tables.map((t) => t.name), ["customers", "orders"]);
    assert.match(result.sql, /HAVING COUNT/);
  });

  test("чистит идентификаторы и типы", () => {
    const result = generator.normalize({
      tables: [{ name: "order items", columns: [{ name: "1id", type: "VARCHAR(255)", key: "primary key PK" }, "note"] }],
      relationships: [{ from: "order items", to: "missing" }],
      sql: "```sql\nSELECT 1\n```",
    });
    const table = result.tables[0];
    assert.equal(table.name, "order_items");
    assert.deepEqual(table.columns[0], { name: "_1id", type: "VARCHAR_255", key: "PK", description: "" });
    assert.equal(table.columns[1].name, "note");
    assert.deepEqual(result.relationships, []); // связь на несуществующую таблицу отброшена
    assert.equal(result.sql, "SELECT 1");
  });

  test("нужны SQL и таблицы", () => {
    assert.throws(() => generator.normalize({ tables: [], sql: "SELECT 1" }), generator.LLMResponseError);
    assert.throws(() => generator.normalize({ tables: [{ name: "t" }], sql: "" }), generator.LLMResponseError);
  });

  test("вопрос не про данные", () => {
    assert.throws(() => generator.normalize({ off_topic: true, explanation: "Это просьба написать стих" }),
      generator.OffTopicError);
  });
});

describe("Mermaid", () => {
  test("сборка erDiagram", () => {
    const code = generator.buildMermaid(generator.normalize(generator.DEMO_RESPONSE));
    assert.ok(code.startsWith("erDiagram"));
    assert.ok(code.includes('customers ||--o{ orders : "оформляет"'));
    assert.ok(code.includes('INT customer_id PK "ID клиента"'));
    assert.ok(code.includes("INT customer_id FK"));
  });

  test("fixSvgSize", () => {
    const svg = '<svg id="m" width="100%" style="max-width: 450px;" viewBox="0 0 450.5 587.25"><g/></svg>';
    const fixed = mermaid.fixSvgSize(svg);
    assert.ok(!fixed.includes('width="100%"'));
    assert.ok(fixed.includes('width="450.5" height="587.25"><g/></svg>'));
  });

  test("pako туда и обратно", () => {
    const token = mermaid.pakoEncode("erDiagram\n  a ||--o{ b : x");
    const raw = Buffer.from(token.slice(5).replace(/-/g, "+").replace(/_/g, "/"), "base64");
    assert.equal(JSON.parse(inflateSync(raw).toString("utf8")).code, "erDiagram\n  a ||--o{ b : x");
  });
});
