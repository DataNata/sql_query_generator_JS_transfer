# SQL Query Generator (JavaScript, для Netlify)

Веб-приложение: пользователь пишет вопрос на естественном языке («Показать всех клиентов,
у которых больше 3 заказов»), LLM придумывает подходящую структуру БД и пишет SQL. На экране:

1. **ER-диаграмма** таблиц — рендерит открытый API MermaidChart (`mermaid.ink`), при недоступности — mermaid.js в браузере;
2. **SQL-запрос** с подсветкой и кнопкой копирования;
3. **краткое объяснение** логики запроса.

Управление: поле запроса, ползунок температуры (0–1), выбор модели LLM, выбор диалекта SQL.
Вход — по паролю. Это JavaScript-версия проекта `sql_query_generator` (Python), переделанная под Netlify.

## Публикация на Netlify

1. Выложите папку в репозиторий GitLab/GitHub и подключите его в Netlify
   (**Add new site → Import an existing project**). Сборки нет: Netlify берёт настройки из `netlify.toml`
   и сам ставит зависимости из `package.json`.
   Без репозитория: `npm i -g netlify-cli`, затем в папке проекта `netlify deploy --prod`.
   Перетаскивание папки в браузер **не подойдёт** — так не публикуются функции.
2. В **Site configuration → Environment variables** задайте:

   | Переменная | Значение |
   |---|---|
   | `APP_PASSWORD` | пароль входа |
   | `SESSION_SECRET` | длинная случайная строка: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
   | `GROQ_API_KEY`, `OPENAI_API_KEY`, … | ключи нужных провайдеров (см. таблицу ниже) |

3. Сделайте повторный деплой (**Deploys → Trigger deploy**) — переменные подхватываются при деплое.

Файл `.env` на Netlify не используется и в репозиторий не попадает (`.gitignore`).

## Локальный запуск

Нужен Node.js 22+. Дважды щёлкните **`run.bat`** или:

```bash
copy .env.example .env      # заполнить APP_PASSWORD, SESSION_SECRET, ключи
node dev-server.mjs         # → http://127.0.0.1:8000  (другой порт: set PORT=8010)
```

`dev-server.mjs` повторяет работу Netlify (охранник входа, функции, статика), но хранит счётчики в памяти
и не требует `npm install`. Полная эмуляция Netlify — `npx netlify dev` (нужен netlify-cli и `npm install`).

Тесты: `npm test`

## Поддерживаемые LLM

| Провайдер | Переменные | API |
|---|---|---|
| OpenAI (GPT-4.1 / 4.1 mini) | `OPENAI_API_KEY` | Chat Completions, JSON mode |
| Anthropic (Claude Sonnet / Haiku) | `ANTHROPIC_API_KEY` | Messages API |
| Google Gemini 2.5 Flash | `GEMINI_API_KEY` | generateContent, `application/json` |
| Groq (GPT-OSS 120B, Qwen3.8 27B) | `GROQ_API_KEY` | OpenAI-совместимый |
| YandexGPT Pro | `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` | Foundation Models completion |
| OpenRouter (DeepSeek и др.) | `OPENROUTER_API_KEY` | OpenAI-совместимый |
| Ollama | `OLLAMA_BASE_URL` | OpenAI-совместимый; с Netlify нужен публичный адрес, до вашего localhost он не достучится |

Новая модель добавляется одной строкой в список `MODELS` в [lib/llm.mjs](lib/llm.mjs).

**Время ответа.** Функция Netlify работает не дольше ~60 с (на части аккаунтов фактически меньше),
поэтому LLM получает 45 с, mermaid.ink — 8 с. Для быстрых моделей (Groq, Gemini Flash, GPT-4.1 mini)
этого с запасом хватает; медленные модели с длинным ответом могут не успеть.

## Архитектура

```
Браузер ──▶ Edge Function (netlify/edge-functions/auth.mjs)
              │ нет подписанной cookie → /login (страницы) или 401 (API)
              ▼
            public/  (index.html, login.html, app.js, style.css)
            /api/models, /api/generate, /api/login, /api/logout → netlify/functions/*.mjs
                                                                   │  вся логика — lib/handlers.mjs
   POST /api/generate:                                             ▼
     1. guards.cleanQuestion       → проверка запроса
     2. RateLimiter (Netlify Blobs) → лимиты частоты
     3. generator.buildMessages    → промпт
     4. llm.complete               → ответ LLM (JSON)
     5. generator.normalize        → валидация, очистка идентификаторов
     6. guards.checkReadonlySql    → только SELECT / WITH
     7. generator.buildMermaid     → код erDiagram
     8. mermaid.renderSvg          → SVG с mermaid.ink
   ◀── {tables, relationships, sql, explanation, mermaid, diagram, meta}
```

Решения:

- **LLM возвращает структуру схемы (JSON), а не готовый Mermaid.** Код `erDiagram` собирается детерминированно,
  поэтому синтаксические ошибки модели не ломают диаграмму. Идентификаторы и типы очищаются,
  связи на несуществующие таблицы отбрасываются.
- **Сессии без хранения на сервере.** Функции Netlify ничего не помнят между вызовами, поэтому вход —
  cookie `<id>.<срок>.<подпись HMAC-SHA256 секретом SESSION_SECRET>`. Срок 12 часов. Смена `SESSION_SECRET`
  (или пароля, если секрет не задан) завершает все сессии. Кнопка «Выйти» удаляет cookie в браузере.
- **Счётчики лимитов — в Netlify Blobs** (хранилище `sqlgen-limits`). Правило «один запрос одновременно»
  соблюдается приблизительно: у хранилища нет блокировок, и два запроса в одну долю секунды могут пройти вместе.
- **Журнал** — строки `[journal] {...}` в логах функций (Netlify → Logs → Functions): время, IP, модель,
  длина запроса, результат, время ответа. Текст запроса не пишется.
- **Рендер через mermaid.ink на сервере** в формате `pako` (zlib + base64url), как в Mermaid Live Editor:
  та же строка даёт ссылку «Открыть в Mermaid Live» и PNG.
- Сгенерированный SQL **нигде не выполняется**.

## Ограничения

Все числа — в начале [lib/guards.mjs](lib/guards.mjs).

| Что | Правило | Ответ |
|---|---|---|
| Длина запроса | 10–500 символов, минимум 2 слова; лишние пробелы сжимаются | 400 |
| Мусор | один символ подряд не больше 5 раз (цифры не считаются), «слово» не длиннее 40 символов, есть буквы | 400 |
| Частота | 10 генераций в минуту и 200 за 24 часа на сессию | 429 |
| Параллельность | один запрос одновременно на сессию | 409 |
| Вход | после 5 неверных паролей вход с этого IP блокируется на 15 минут | редирект на `/login` с сообщением |
| SQL | только один `SELECT`/`WITH`; `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `INTO` и т.п. отклоняются | 502 |
| Не про данные | модель возвращает `off_topic`, схема не строится | 400 |
| LLM | тайм-аут 45 с, ответ до 2500 токенов ([lib/llm.mjs](lib/llm.mjs)) | 502 |

Те же правила ввода проверяются в браузере ([public/app.js](public/app.js)): счётчик `0 / 500`, кнопка неактивна,
пока запрос не прошёл проверку. Меняете лимит длины — поменяйте его в `lib/guards.mjs`,
в `maxlength` в `public/index.html` и в объекте `Q` в `public/app.js`.

## Файлы

| Путь | Назначение |
|---|---|
| `netlify.toml` | настройки Netlify: папки сайта и функций, Node 22, заголовки безопасности |
| `netlify/edge-functions/auth.mjs` | «охранник» перед всем сайтом: без входа — на `/login` |
| `netlify/functions/*.mjs` | функции `/api/models`, `/api/generate`, `/api/login`, `/api/logout` (тонкие обёртки) |
| `lib/handlers.mjs` | обработчики API — общие для Netlify и `dev-server.mjs` |
| `lib/generator.mjs` | промпт, разбор JSON-ответа, нормализация, сборка Mermaid, демо-ответ |
| `lib/llm.mjs` | клиенты провайдеров на `fetch`, реестр моделей |
| `lib/mermaid.mjs` | кодирование `pako`, запрос SVG к mermaid.ink |
| `lib/guards.mjs` | ограничения: проверка запроса, лимиты, блокировка входа, read-only SQL, журнал |
| `lib/auth.mjs` | пароль, подписанная cookie, решение «охранника» (Web Crypto — работает и в Edge, и в Node) |
| `lib/store.mjs` | хранилище счётчиков: Netlify Blobs или память |
| `public/` | интерфейс (HTML/CSS/JS) |
| `dev-server.mjs`, `run.bat` | локальный запуск |
| `tests/` | тесты (`node:test`) |
