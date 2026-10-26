#!/usr/bin/env node
// Git pre-commit: дублює ключові block-правила docs/guardrails.md на рівні git,
// тож вони діють навіть якщо hook агентної IDE оминули (інша IDE, ручний виклик).
// Агента розпізнаємо за змінною CLAUDECODE=1, яку Claude Code передає своїм bash-командам.
import { execFileSync } from "node:child_process";

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const staged = git("diff", "--cached", "--name-only", "--diff-filter=ACMR")
  .split("\n")
  .filter(Boolean);
const branch = git("symbolic-ref", "--short", "-q", "HEAD"); // працює й до першого коміту
const byAgent = process.env.CLAUDECODE === "1";
const errors = [];

// G-B01: секрети не потрапляють у репозиторій
for (const f of staged) {
  const b = f.split("/").pop();
  if (
    (/^\.env(\..+)?$/.test(b) && b !== ".env.example") ||
    /\.(pem|key|p12|pfx)$/.test(b)
  )
    errors.push(`B-01 секретний файл у коміті: ${f}`);
}

// G-B09: послаблення перевірок у доданих рядках
const added = git(
  "diff",
  "--cached",
  "-U0",
  "--",
  "*.ts",
  "*.tsx",
  "*.js",
  "*.mjs",
  ":(exclude).claude/hooks/**",
  ":(exclude).githooks/**",
) // ці файли містять шаблони B-09 як текст правил; агенту їх змінювати забороняє B-08
  .split("\n")
  .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
for (const l of added) {
  if (
    /\b(describe|it|test)\.(only|skip)\s*\(|@ts-(ignore|nocheck)|\/\*\s*eslint-disable\s*\*\//.test(
      l,
    )
  ) {
    errors.push(
      `B-09 послаблення перевірок: ${l.slice(1).trim().slice(0, 80)}`,
    );
  }
  if (
    /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(
      l,
    )
  ) {
    errors.push("B-01 рядок, схожий на секрет (токен / ключ)");
  }
}

// G-B04 / G-B08: обмеження саме для агента
if (byAgent && ["main", "master"].includes(branch))
  errors.push(
    `B-04 агент не комітить напряму в ${branch} — створіть гілку feature/*`,
  );
if (byAgent) {
  for (const f of staged) {
    if (
      /^(\.claude\/settings(\.local)?\.json|\.claude\/hooks\/|\.mcp\.json|\.githooks\/)/.test(
        f,
      )
    )
      errors.push(`B-08 агент не змінює конфігурацію harness: ${f}`);
  }
}

if (errors.length) {
  console.error(
    "✗ pre-commit guardrails:\n" +
      errors.map((e) => "  - " + e).join("\n") +
      "\nДив. docs/guardrails.md",
  );
  process.exit(1);
}
