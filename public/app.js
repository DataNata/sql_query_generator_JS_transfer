"use strict";

const $ = (id) => document.getElementById(id);

const EXAMPLES = [
  "Показать всех клиентов, у которых больше 3 заказов",
  "Топ-5 товаров по выручке за последний месяц",
  "Сотрудники, чья зарплата выше средней по отделу",
  "Студенты, не сдавшие ни одного экзамена",
];

let models = [];

// ---------- Проверка запроса (те же правила, что в lib/guards.mjs на сервере) ----------
const Q = { min: 10, max: 500, minWords: 2, maxRun: 5, maxWord: 40 };

function cleanQuestion(raw) {
  return raw.replace(/\s+/g, " ").trim();
}

function validateQuestion(raw) {
  const text = cleanQuestion(raw);
  if (!text) return "Введите запрос пользователя";
  if (text.length > Q.max) return `Слишком длинно: максимум ${Q.max} символов`;
  if (text.length < Q.min) return `Слишком коротко: минимум ${Q.min} символов`;
  if (!/\p{L}/u.test(text)) return "Нужны слова, а не только цифры и знаки";
  if ((text.match(/[\p{L}\p{N}]+/gu) || []).length < Q.minWords) return `Минимум ${Q.minWords} слова`;
  const run = text.match(new RegExp(String.raw`([^\d\s])\1{${Q.maxRun},}`, "u"));
  if (run) return `Похоже на случайный ввод: «${run[1]}» повторяется больше ${Q.maxRun} раз подряд`;
  if (new RegExp(String.raw`\S{${Q.maxWord + 1},}`, "u").test(text)) return `Похоже на случайный ввод: «слово» длиннее ${Q.maxWord} символов`;
  return "";
}

let busy = false;

function updateQuestionState() {
  const raw = $("question").value;
  const len = raw.length;
  const count = $("qCount");
  count.textContent = `${len} / ${Q.max}`;
  count.classList.toggle("near", len >= Q.max * 0.9 && len < Q.max);
  count.classList.toggle("full", len >= Q.max);
  const problem = validateQuestion(raw);
  // Пустое поле — без красной подсказки, просто неактивная кнопка
  $("qHint").textContent = raw.trim() ? problem : "";
  $("submit").disabled = busy || Boolean(problem);
}

// ---------- Инициализация ----------
async function init() {
  EXAMPLES.forEach((text) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = text;
    chip.onclick = () => { $("question").value = text; updateQuestionState(); $("question").focus(); };
    $("examples").appendChild(chip);
  });

  try {
    const res = await fetch("/api/models");
    if (res.status === 401) { location.href = "/login"; return; }
    const data = await res.json();
    models = data.models;
    // По умолчанию — первая модель с заданным ключом, иначе демо-режим
    const firstAvailable = models.find((m) => m.available && m.requires.length) || models.find((m) => m.id === "demo");
    for (const m of models) {
      const opt = new Option(m.available ? m.label : `${m.label} — нет ключа`, m.id);
      $("model").add(opt);
    }
    $("model").value = firstAvailable.id;
    for (const [id, label] of Object.entries(data.dialects)) $("dialect").add(new Option(label, id));
  } catch (e) {
    showError("Не удалось загрузить список моделей: " + e.message);
  }
  updateModelNote();
  updateTemperature();
  updateQuestionState();
}

function updateTemperature() {
  const t = parseFloat($("temperature").value);
  $("tempValue").textContent = t.toFixed(1);
  $("tempHint").textContent = t <= 0.3 ? "Более строго" : t <= 0.6 ? "Сбалансировано" : "Более креативно";
}

function updateModelNote() {
  const m = models.find((x) => x.id === $("model").value);
  const note = $("modelNote");
  if (m && !m.available) {
    note.textContent = `Для этой модели задайте переменные окружения (Netlify → Environment variables): ${m.requires.join(", ")}`;
    note.hidden = false;
  } else if (m && m.id === "demo") {
    note.textContent = "Демо-режим возвращает фиксированный пример из ТЗ без обращения к LLM.";
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

// ---------- Состояния правой панели ----------
function setState(state) {
  $("placeholder").hidden = state !== "empty";
  $("loading").hidden = state !== "loading";
  $("output").hidden = state !== "done";
  if (state !== "error") $("error").hidden = true;
  busy = state === "loading";
  updateQuestionState();
  $("submit").textContent = state === "loading" ? "Генерация…" : "Сгенерировать";
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = false;
}

// ---------- Генерация ----------
async function generate(event) {
  event?.preventDefault();
  if (busy) return;
  const problem = validateQuestion($("question").value);
  if (problem) {
    $("question").focus();
    showError(problem + ".");
    return;
  }
  const question = cleanQuestion($("question").value);

  setState("loading");
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        model: $("model").value,
        temperature: parseFloat($("temperature").value),
        dialect: $("dialect").value,
      }),
    });
    if (res.status === 401) { location.href = "/login"; return; }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await render(data);
    setState("done");
  } catch (e) {
    setState($("output").dataset.filled ? "done" : "empty");
    showError("Ошибка генерации: " + e.message);
  }
}

async function render(data) {
  $("meta").innerHTML = "";
  [data.meta.model, `t = ${data.meta.temperature}`, data.meta.dialect,
   `таблиц: ${data.tables.length}`, `${data.meta.elapsed_sec} с`].forEach((text) => {
    const s = document.createElement("span");
    s.textContent = text;
    $("meta").appendChild(s);
  });

  // ER-диаграмма: картинка из mermaid.ink, при недоступности — локальный mermaid.js
  const box = $("diagram");
  box.innerHTML = "";
  if (data.diagram.image) {
    const img = new Image();
    img.alt = "ER-диаграмма";
    img.src = data.diagram.image;
    box.appendChild(img);
  } else {
    await renderLocalMermaid(box, data.mermaid, data.diagram.warning);
  }
  $("editLink").href = data.diagram.edit_url;
  $("pngLink").href = data.diagram.png_url;
  $("mermaidCode").textContent = data.mermaid;

  $("sql").innerHTML = highlightSql(data.sql);
  $("sql").dataset.raw = data.sql;
  $("explanation").textContent = data.explanation || "Модель не вернула объяснение.";
  $("output").dataset.filled = "1";
}

let mermaidLoaded = null;
function loadMermaid() {
  mermaidLoaded ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";
    s.onload = () => { window.mermaid.initialize({ startOnLoad: false, theme: "default" }); resolve(window.mermaid); };
    s.onerror = () => reject(new Error("не удалось загрузить mermaid.js"));
    document.head.appendChild(s);
  });
  return mermaidLoaded;
}

async function renderLocalMermaid(box, code, warning) {
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render("er-" + Date.now(), code);
    box.innerHTML = svg;
    const note = document.createElement("p");
    note.className = "fallback-note";
    note.textContent = `MermaidChart API недоступен (${warning}); диаграмма отрисована локально.`;
    box.appendChild(note);
  } catch (e) {
    box.innerHTML = "";
    const p = document.createElement("p");
    p.className = "fallback-note";
    p.textContent = "Не удалось отрисовать диаграмму: " + e.message + ". Mermaid-код доступен ниже.";
    box.appendChild(p);
  }
}

// ---------- Подсветка SQL ----------
const SQL_KEYWORDS = ["SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS",
  "ON", "AS", "AND", "OR", "NOT", "IN", "IS", "NULL", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET",
  "TOP", "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX", "WITH", "UNION", "ALL", "CASE", "WHEN", "THEN",
  "ELSE", "END", "DESC", "ASC", "BETWEEN", "LIKE", "ILIKE", "EXISTS", "OVER", "PARTITION", "ROW_NUMBER",
  "RANK", "DENSE_RANK", "INTERVAL", "CURRENT_DATE", "COALESCE", "CAST", "FETCH", "FIRST", "ROWS", "ONLY"];
const KW_RE = new RegExp(`\\b(${SQL_KEYWORDS.join("|")})\\b`, "gi");

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function highlightSql(sql) {
  // Токенизируем: комментарии и строки не подсвечиваем как ключевые слова
  const parts = sql.split(/(--[^\n]*|'(?:[^']|'')*')/g);
  return parts.map((p, i) => {
    if (i % 2 === 1) {
      return p.startsWith("--") ? `<span class="cmt">${escapeHtml(p)}</span>` : `<span class="str">${escapeHtml(p)}</span>`;
    }
    return escapeHtml(p)
      .replace(KW_RE, '<span class="kw">$1</span>')
      .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="num-lit">$1</span>');
  }).join("");
}

// ---------- События ----------
$("form").addEventListener("submit", generate);
$("question").addEventListener("input", updateQuestionState);
$("temperature").addEventListener("input", updateTemperature);
$("model").addEventListener("change", updateModelNote);
$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) generate(e);
});
$("copySql").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("sql").dataset.raw || "");
    $("copySql").textContent = "Скопировано ✓";
  } catch {
    $("copySql").textContent = "Не удалось";
  }
  setTimeout(() => ($("copySql").textContent = "Копировать"), 1500);
});

init();
