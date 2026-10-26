# fridge-kb — MCP-конектор до бази знань

MCP-сервер (stdio, `@modelcontextprotocol/sdk`), через який агент Claude Code
читає й поповнює базу знань застосунку — Obsidian vault в окремому репозиторії
[`whats-in-the-fridge-vault`](https://github.com/PashaMylkus/whats-in-the-fridge-vault).
Прямого доступу до клону vault агент не має: клон лежить поза робочою директорією IDE.

## Інструменти

| Інструмент | Тип | Що робить |
|---|---|---|
| `search_notes(query, type?, limit?)` | retrieval | пошук за назвою, aliases, тегами й текстом |
| `get_note(id \| title)` | retrieval | frontmatter, текст, вихідні посилання й backlinks |
| `vault_status()` | retrieval | коміт, гілка, чи чистий клон, кількість нотаток за типами |
| `ingest_note(type, title, content, …)` | ingestion | створити / оновити нотатку → MOC → commit → push |

### Цикл `ingest_note`

1. `git pull --ff-only` у клоні vault (розбіжна історія — помилка, а не автоматичне злиття).
2. Пошук наявної нотатки: за `id` → за назвою → для ADR за назвою без префікса `ADR-NNNN`.
   Для `change` з `fields.commit` id = `change-<sha7>`.
3. Формування frontmatter за конвенціями vault (спільні поля + поля типу, перевірка
   `status`, `layer`, `kind`, допустимих полів); `created` наявної нотатки зберігається.
4. Перевірка: усі `[[посилання]]` розв'язуються, назва без заборонених символів, шлях у межах vault.
5. Якщо вміст (без поля `updated`) не змінився — `unchanged`, без запису й коміту.
6. Запис файлу; для нової нотатки — посилання в потрібний розділ `MOC-Застосунок`.
7. `git commit -m "kb(<type>): <created|updated> <id>"` і `git push`.
8. Відповідь: `{ status, id, title, path, moc_updated, commit, pushed, warnings }`.

Записи виконуються послідовно (черга), тож паралельні виклики не конфліктують у git.

## Запуск

```bash
cd mcp-server && npm install && npm run build
```

Сервер реєструється в `.mcp.json` у корені репозиторію і запускається самим Claude Code.

| Змінна | Типово | Призначення |
|---|---|---|
| `VAULT_PATH` | `../whats-in-the-fridge-vault` | шлях до клону vault |
| `APP_PATH` | корінь проєкту | репозиторій застосунку (поле `source`) |
| `KB_GIT_PULL` / `KB_GIT_PUSH` | `1` | вимкнути pull / push (`0`) |

Перевірка: `claude mcp list` або `/mcp` в інтерактивній сесії.

## Тести

```bash
npm test
```

Інтеграційні тести запускають сервер окремим процесом і викликають інструменти через
MCP-клієнт по stdio на тимчасовому vault із bare-репозиторієм як origin: створення,
ідемпотентний повтор, оновлення, нумерація ADR, відхилення битих посилань і шляхів,
git pull перед записом, пошук і backlinks.
