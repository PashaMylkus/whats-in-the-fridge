---
title: Guardrails — «Що в холодильнику»
version: 1.0
date: 2026-10-26
author: Милькус Павло Романович, ІТ-51
status: затверджено (ПР № 4)
related: [harness-requirements.md]
---

# Guardrails

Конкретні, перевірювані правила дій агента Claude Code над кодовою базою застосунку
та базою знань (vault). Деталізують категорії розділу 5 `harness-requirements.md` (ПР № 1).

## Механізми

| Рівень | Реакція | Механізм (від основного до додаткового) |
|---|---|---|
| **Allow** | виконується без підтвердження | `permissions.allow` у `.claude/settings.json`; hook мовчить |
| **Warn** | потрібне підтвердження людини | hook `PreToolUse` → `permissionDecision: "ask"`; дублюється `permissions.ask` |
| **Block** | заборонено безумовно | hook `PreToolUse` → `permissionDecision: "deny"`; дублюється `permissions.deny` і, для частини правил, git `pre-commit` |

- Hook: `.claude/hooks/guardrails.mjs` (Node.js, без залежностей), реєстрація — `.claude/settings.json`.
  Порядок перевірки: спочатку block-правила, потім warn; перше спрацьоване правило визначає рішення.
  Нерозбірний вхід або внутрішня помилка hook-а в режимі `pre` → блокування (fail-closed).
- `PostToolUse` (той самий скрипт, режим `post`): перевірка результату й зворотний зв'язок агенту.
- Git `pre-commit` (`.githooks/`, вмикається `git config core.hooksPath .githooks`): незалежний від IDE рубіж.
  Агента розпізнає за `CLAUDECODE=1`, яку Claude Code передає своїм bash-командам.
- Кожне рішення пишеться в `.claude/logs/guardrails.jsonl` (не комітиться) — дані для метрики
  «guardrail violations» (ПР № 7).
- `CLAUDE.md` пояснює правила агенту, але **не є** механізмом захисту.

## Allow

| ID | Правило | Приклади дій |
|---|---|---|
| A-01 | Читання й пошук у репозиторії застосунку, крім секретів і vault | `Read apps/api/src/index.ts`, `Grep`, `Read .env.example` |
| A-02 | Read-only команди git | `git status`, `git diff`, `git log`, `git show`, `git branch` |
| A-03 | Локальні перевірки й очищення артефактів | `npm test`, `npm run lint / typecheck / build`, `npx vitest run`, `rm -rf node_modules dist` |
| A-04 | Retrieval із бази знань і GitHub (read-only) | `search_notes`, `get_note`, `vault_status`, `ingest_note` з `dry_run`, `mcp__github__get_* / list_*` |
| A-05 | Створення робочої гілки | `git switch -c feature/<назва>` |
| A-06 | Редагування тестів (з урахуванням B-09) | `Edit apps/**/*.test.ts`, `mcp-server/test/**` |

## Warn (require approval)

| ID | Правило | Приклади дій |
|---|---|---|
| W-01 | Зміна доменного ядра `packages/shared/src/domain/**` | `Edit …/domain/freshness.ts` |
| W-02 | Зміна схеми чи міграцій БД | `Edit prisma/schema.prisma`, `npx prisma migrate dev` |
| W-03 | Зміна залежностей | `npm install zod`, `Edit package.json` |
| W-04 | Коміт, push, merge, tag у робочій гілці | `git commit -m "feat(products): crud"`, `git push origin feature/x` |
| W-05 | Запис у базу знань | `ingest_note` (без `dry_run`) |
| W-06 | Мережеві запити | `WebFetch`, `curl`, `wget` |
| W-07 | Зміна вимог, guardrails, інструкцій агента | `Edit docs/guardrails.md`, `Edit CLAUDE.md` |

Інші зміни файлів коду підтверджуються стандартним механізмом Claude Code (режим за замовчуванням).
Правила W-01…W-07 вимагають підтвердження **навіть** у режимі `acceptEdits`.

## Block

| ID | Правило | Приклади дій | IDE hook | permissions.deny | pre-commit |
|---|---|---|---|---|---|
| B-01 | Доступ до секретів: `.env*` (крім `.env.example`), `*.pem`, `*.key`, `id_rsa` | `Read .env`, `cat .env`, `echo "$(cat .env)"` | ✓ | ✓ | ✓ (файли й токени в diff) |
| B-02 | Прямий доступ до vault в обхід MCP | `Read ../whats-in-the-fridge-vault/…`, `rm ../…-vault/Decisions/…` | ✓ | ✓ | — |
| B-03 | Push у `main`/`master`, force-push, видалення віддалених гілок | `git push -f`, `git push origin HEAD:main`, `git push` з `main` | ✓ | частково | — |
| B-04 | Коміт напряму в `main`/`master`; `--no-verify` | `git commit` на `main`, `git commit -n` | ✓ | — | ✓ (для агента) |
| B-05 | Руйнівні git-операції | `git reset --hard`, `git clean -fd`, `git branch -D`, `git rebase`, `filter-branch` | ✓ | ✓ | — |
| B-06 | Рекурсивне / примусове видалення поза артефактами збірки | `rm -rf apps/api/src`, `find . -delete` | ✓ | — | — |
| B-07 | Руйнівні операції з БД | `prisma migrate reset`, `db push --force-reset`, `DROP TABLE`, `rm dev.db` | ✓ | ✓ | — |
| B-08 | Самомодифікація harness | `Edit .claude/settings.json`, `echo > .mcp.json`, `git config core.hooksPath` | ✓ | ✓ | ✓ (для агента) |
| B-09 | Послаблення перевірок | `it.only(`, `describe.skip(`, `@ts-ignore`, `@ts-nocheck`, `/* eslint-disable */` | ✓ | — | ✓ |
| B-10 | Публікація й зміна налаштувань GitHub | `npm publish`, `gh release create`, `gh repo edit`, `gh api -X DELETE` | ✓ | ✓ | — |

Для vault окремо: видалення нотаток (зокрема `Decisions/`) неможливе — у MCP-сервері немає
інструмента видалення, а прямий доступ до файлів заборонено B-02. Запис можливий лише через
`ingest_note` (W-05) з валідацією конвенцій і онтології.

## PostToolUse

| ID | Перевірка | Реакція |
|---|---|---|
| P-01 | У записаному файлі з'явився рядок, схожий на секрет (`ghp_…`, `github_pat_…`, `sk-…`, `AKIA…`, приватний ключ) | `decision: block` + інструкція прибрати секрет |
| P-02 | Повідомлення щойно створеного коміту не відповідає Conventional Commits | `decision: block` + інструкція виправити `--amend` |

## Тест-кейси

Автоматичні: `node --test .claude/hooks/` — hook запускається окремим процесом із JSON на stdin,
як його викликає Claude Code; git pre-commit перевіряється на тимчасовому репозиторії.

| ID | Правило | Сценарій дії агента | Очікувана реакція |
|---|---|---|---|
| TC-A1 | A-01 | `Read apps/api/src/index.ts` | hook мовчить → дозволено |
| TC-A2 | A-02 | `git status && git log --oneline -5` | дозволено |
| TC-A3 | A-03 | `npm test` | дозволено |
| TC-A4 | A-04 | `search_notes("термін придатності")` | дозволено |
| TC-A5 | A-05 | `git switch -c feature/products-crud` | дозволено |
| TC-A6 | A-04 | `ingest_note(..., dry_run: true)` | дозволено |
| TC-A7 | A-01 | `Read .env.example` | дозволено (не секрет) |
| TC-A8 | A-03 | `rm -rf node_modules dist` | дозволено |
| TC-W1 | W-01 | `Edit packages/shared/src/domain/freshness.ts` | ask |
| TC-W2 | W-02 | `npx prisma migrate dev --name add_products` | ask |
| TC-W3 | W-03 | `npm install zod` | ask |
| TC-W4 | W-04 | `git commit` у `feature/products-crud` | ask |
| TC-W5 | W-05 | `ingest_note(...)` | ask |
| TC-W6 | W-06 | `curl -s https://example.com` | ask |
| TC-W7 | W-07 | `Edit docs/guardrails.md` | ask |
| TC-B1 | B-01 | `Read .env` | deny |
| TC-B2 | B-01 | `echo "$(cat .env)" \| head` | deny (команда в підстановці) |
| TC-B3 | B-02 | `Read ../whats-in-the-fridge-vault/Concepts/Продукт.md` | deny |
| TC-B4 | B-02 | `rm ../whats-in-the-fridge-vault/Decisions/ADR-0001.md` | deny |
| TC-B5 | B-03 | `cd apps && git push -f origin feature/x` | deny (складена команда) |
| TC-B6 | B-03 | `git push origin HEAD:main` | deny |
| TC-B7 | B-04 | `git add -A && git commit -m "fix: x"` на `main` | deny |
| TC-B8 | B-04 | `git commit --no-verify` | deny |
| TC-B9 | B-05 | `timeout 5 git reset --hard HEAD~1` | deny (обгортка) |
| TC-B10 | B-06 | `rm -rf apps/api/src` | deny |
| TC-B11 | B-07 | `npx prisma migrate reset --force` | deny |
| TC-B12 | B-08 | `Edit .claude/settings.json` | deny |
| TC-B13 | B-08 | `echo '{}' > .mcp.json` | deny |
| TC-B14 | B-08 | `git config core.hooksPath /dev/null` | deny |
| TC-B15 | B-09 | `Edit …test.ts`: `it(` → `it.only(` | deny |
| TC-B16 | B-10 | `npm publish` | deny |
| TC-P1 | P-01 | `Write apps/config.ts` з `ghp_…` | block після виконання |
| TC-P2 | P-02 | коміт `update stuff` | block після виконання |
| TC-P3 | P-02 | коміт `docs: add b` | без зауважень |
| TC-G1 | B-01 | `git commit` з `.env` | pre-commit відхиляє |
| TC-G2 | B-09 | `git commit` з `it.only` (людина) | pre-commit відхиляє |
| TC-G3 | B-04 | `git commit` на `main` з `CLAUDECODE=1` / без | агенту відмова / людині дозволено |
| TC-G4 | B-08 | агент комітить зміну `.githooks/` у `feature/x` | pre-commit відхиляє |

Наскрізна перевірка в агентній IDE: сесія Claude Code в ізольованій копії репозиторію (origin —
локальний bare-репозиторій) з проханням виконати заборонені дії; спрацювання hook-а підтверджується
відповідями агенту й записами `.claude/logs/guardrails.jsonl`.
