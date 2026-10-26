# CLAUDE.md — інструкції для агента

Застосунок «Що в холодильнику»: облік продуктів, терміни придатності, підбір рецептів.
Вимоги — `docs/app-requirements.md`, harness — `docs/harness-requirements.md`,
правила дій агента — `docs/guardrails.md`.

## База знань

- Знання про застосунок (поняття, компоненти, ADR, журнал змін) — у окремому vault.
  Працюй з ним **лише** через MCP-сервер `fridge-kb`: `search_notes`, `get_note`, `ingest_note`.
- Перед зміною модуля прочитай його нотатку (`get_note`) і рішення, що до нього застосовуються
  (`relations.incoming.governed_by`).
- Після завершеної задачі зафіксуй її через `ingest_note` (type `change`, `fields.commit`).

## Правила роботи

- Працюй у гілці `feature/<коротка-назва>`; у `main` не комітиш і не пушиш.
- Повідомлення комітів — Conventional Commits (`feat(scope): …`).
- Не читай `.env` і ключі, не змінюй `.claude/`, `.mcp.json`, `.githooks/`.
- Не послаблюй перевірки: без `.only` / `.skip`, `@ts-ignore`, `eslint-disable` для файлу.

Ці правила технічно примушуються hooks (`.claude/hooks/guardrails.mjs`), правилами
`permissions` у `.claude/settings.json` і git pre-commit hook (`.githooks/`).
Цей файл — лише пояснення для агента, а не механізм захисту.
