#!/usr/bin/env node
// Guardrails hook для Claude Code (PreToolUse / PostToolUse).
// Правила описано в docs/guardrails.md; id правил збігаються.
//   node .claude/hooks/guardrails.mjs pre   — перед викликом інструмента: deny (block) / ask (warn) / мовчки (далі — permissions)
//   node .claude/hooks/guardrails.mjs post  — після виклику: перевірка результату, зворотний зв'язок агенту
// Без залежностей; Node.js >= 18. Кожне рішення пишеться в .claude/logs/guardrails.jsonl.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MODE = process.argv[2] === "post" ? "post" : "pre";
const PROJECT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const VAULT = path.resolve(
  process.env.VAULT_PATH ||
    path.join(PROJECT, "..", "whats-in-the-fridge-vault"),
);
const VAULT_NAME = path.basename(VAULT);

// ---------------------------------------------------------------- розбір Bash-команд
/** Ділить команду на підкоманди за &&, ||, ;, |, & і переносами рядка, враховуючи лапки. */
export function splitCommands(cmd) {
  const out = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === "\n" || c === ";" || c === "|" || c === "&") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      if ((c === "&" || c === "|") && cmd[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  // команди всередині $( … ) і `…` теж перевіряються
  for (const m of cmd.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g))
    out.push(...splitCommands(m[1] ?? m[2]));
  return out;
}

export function tokenize(seg) {
  const t = [];
  let cur = "";
  let q = null;
  for (const c of seg) {
    if (q) {
      if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) t.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) t.push(cur);
  // обгортки й присвоєння змінних середовища перед командою
  while (
    t.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) ||
      [
        "sudo",
        "env",
        "timeout",
        "nohup",
        "time",
        "nice",
        "command",
        "builtin",
        "xargs",
      ].includes(t[0]))
  ) {
    const w = t.shift();
    if (w === "timeout" && /^\d/.test(t[0] ?? "")) t.shift();
  }
  if (t[0]) t[0] = path.basename(t[0]); // /usr/bin/git → git
  return t;
}

/** git [-C dir] [-c k=v] <sub> args → { sub, args } */
function gitParts(t) {
  if (t[0] !== "git") return null;
  let i = 1;
  while (i < t.length && t[i].startsWith("-")) {
    if (["-C", "-c", "--git-dir", "--work-tree"].includes(t[i])) i++;
    i++;
  }
  return { sub: t[i], args: t.slice(i + 1) };
}

function currentBranch(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- шляхи
const rel = (p) =>
  path.relative(PROJECT, path.resolve(PROJECT, p)).split(path.sep).join("/");
const isSecretPath = (p) => {
  const b = path.basename(p);
  return (
    (/^\.env(\..+)?$/.test(b) && b !== ".env.example") ||
    /\.(pem|key|p12|pfx)$/.test(b) ||
    /^id_(rsa|ed25519)/.test(b)
  );
};
const inVault = (p) => {
  const abs = path.resolve(PROJECT, p);
  return (
    abs === VAULT ||
    abs.startsWith(VAULT + path.sep) ||
    abs.split(path.sep).includes(VAULT_NAME)
  );
};
const HARNESS_FILES =
  /^(\.claude\/settings(\.local)?\.json|\.claude\/hooks\/.+|\.mcp\.json|\.githooks\/.+)$/;
const SECRET_IN_CMD =
  /(^|[\s'"=/<>])\.env(\.(?!example\b)[\w.-]+)?(?=$|[\s'";|&)])|\.(pem|key)\b|id_(rsa|ed25519)/;
const WRITE_OPS =
  /(^|\s)(tee|sed\s+-i|mv|cp|rm|chmod|truncate|install|ln)(\s|$)|(^|[^0-9&>])>{1,2}\s*[^&\s]/;
const WEAKEN =
  /\b(describe|it|test)\.(only|skip)\s*\(|@ts-(ignore|nocheck)|\/\*\s*eslint-disable\s*\*\//;
const SECRET_VALUE =
  /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const CLEANABLE =
  /^(node_modules|dist|build|coverage|\.vite|tmp|\.turbo)(\/|$)|\/(node_modules|dist|coverage)(\/|$)/;

// ---------------------------------------------------------------- правила PreToolUse
// Кожне правило повертає причину (рядок), якщо спрацювало.
const BLOCK = [
  [
    "B-01",
    "доступ до секретів (.env, ключі) заборонено",
    ({ tool, file, cmds }) =>
      (file && isSecretPath(file)) ||
      (tool === "Bash" && cmds.some((s) => SECRET_IN_CMD.test(s))),
  ],
  [
    "B-02",
    `прямий доступ до vault (${VAULT_NAME}) в обхід MCP-сервера fridge-kb заборонено`,
    ({ tool, file, input, cmds }) =>
      (file && inVault(file)) ||
      (input.path && inVault(input.path)) ||
      (tool === "Bash" &&
        cmds.some((s) => s.includes(VAULT_NAME) || s.includes(VAULT))),
  ],
  [
    "B-03",
    "push у main/master, force-push і видалення віддалених гілок заборонено — лише push робочої гілки feature/*",
    ({ git, cwd }) =>
      git.some(
        ({ sub, args }) =>
          sub === "push" &&
          (args.some(
            (a) =>
              /^(-f|--force|--force-with-lease.*|--mirror|--delete|-d)$/.test(
                a,
              ) ||
              /^\+/.test(a) ||
              /(^|:)(main|master)$/.test(a),
          ) ||
            (!args.filter((a) => !a.startsWith("-")).slice(1).length &&
              ["main", "master"].includes(currentBranch(cwd)))),
      ),
  ],
  [
    "B-04",
    "коміт напряму в main/master і обхід git-хуків (--no-verify) заборонено — створіть гілку feature/*",
    ({ git, cwd }) =>
      git.some(
        ({ sub, args }) =>
          sub === "commit" &&
          (args.some(
            (a) => a === "--no-verify" || /^-[a-z]*n[a-z]*$/.test(a),
          ) ||
            ["main", "master"].includes(currentBranch(cwd))),
      ),
  ],
  [
    "B-05",
    "руйнівні git-операції (reset --hard, clean -f, branch -D, переписування історії) заборонено",
    ({ git }) =>
      git.some(
        ({ sub, args }) =>
          (sub === "reset" && args.includes("--hard")) ||
          (sub === "clean" && args.some((a) => /^-[a-z]*f/.test(a))) ||
          (sub === "branch" &&
            args.some(
              (a) =>
                a === "-D" || (a === "--delete" && args.includes("--force")),
            )) ||
          ["filter-branch", "filter-repo", "replace"].includes(sub) ||
          sub === "rebase" ||
          (sub === "checkout" && args.includes("--") && args.includes(".")) ||
          (sub === "update-ref" && args.includes("-d")),
      ),
  ],
  [
    "B-06",
    "рекурсивне / примусове видалення поза node_modules, dist, coverage заборонено",
    ({ toks }) =>
      toks.some(
        (t) =>
          (t[0] === "rm" &&
            t.some((a) => /^-[a-zA-Z]*[rRf]/.test(a)) &&
            t
              .slice(1)
              .filter((a) => !a.startsWith("-"))
              .some(
                (a) =>
                  !CLEANABLE.test(rel(a)) || a === "/" || a.startsWith("~"),
              )) ||
          (t[0] === "find" && t.includes("-delete")),
      ),
  ],
  [
    "B-07",
    "руйнівні операції з базою даних (migrate reset, force-reset, DROP, видалення *.db) заборонено",
    ({ cmds, toks }) =>
      cmds.some((s) =>
        /prisma\s+migrate\s+reset|prisma\s+db\s+push\b.*--(force-reset|accept-data-loss)|\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i.test(
          s,
        ),
      ) ||
      toks.some(
        (t) =>
          t[0] === "rm" && t.some((a) => /\.(db|sqlite3?)(-journal)?$/.test(a)),
      ),
  ],
  [
    "B-08",
    "зміна конфігурації harness (.claude/settings, hooks, .mcp.json, .githooks) агентом заборонена",
    ({ tool, file, cmds, git }) =>
      (file &&
        ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool) &&
        HARNESS_FILES.test(rel(file))) ||
      (tool === "Bash" &&
        cmds.some(
          (s) =>
            /(\.claude\/(settings|hooks)|\.mcp\.json|\.githooks)/.test(s) &&
            WRITE_OPS.test(s),
        )) ||
      git.some(
        ({ sub, args }) =>
          sub === "config" && args.some((a) => /core\.hookspath/i.test(a)),
      ),
  ],
  [
    "B-09",
    "послаблення перевірок (.only/.skip, @ts-ignore, @ts-nocheck, eslint-disable для файлу) заборонено",
    ({ tool, input, file }) =>
      ["Edit", "Write", "MultiEdit"].includes(tool) &&
      /\.(m?[jt]sx?|cjs|cts|mts)$/.test(file ?? "") &&
      WEAKEN.test(
        [
          input.new_string,
          input.content,
          ...(input.edits ?? []).map((e) => e.new_string),
        ]
          .filter(Boolean)
          .join("\n"),
      ),
  ],
  [
    "B-10",
    "публікація пакетів, релізи та зміна налаштувань GitHub заборонені",
    ({ toks }) =>
      toks.some(
        (t) =>
          (["npm", "pnpm", "yarn"].includes(t[0]) && t[1] === "publish") ||
          (t[0] === "gh" &&
            (["release", "secret", "variable"].includes(t[1]) ||
              (t[1] === "repo" &&
                ["edit", "delete", "rename", "archive"].includes(t[2])) ||
              (t[1] === "api" &&
                t.some(
                  (a, i) =>
                    (a === "-X" || a === "--method") &&
                    /^(POST|PUT|PATCH|DELETE)$/i.test(t[i + 1]),
                )))),
      ),
  ],
];

const WARN = [
  [
    "W-01",
    "зміна доменного ядра packages/shared/src/domain — потрібне підтвердження розробника",
    ({ tool, file }) =>
      file &&
      ["Edit", "Write", "MultiEdit"].includes(tool) &&
      /^packages\/shared\/src\/domain\//.test(rel(file)),
  ],
  [
    "W-02",
    "зміна схеми чи міграцій БД — потрібне підтвердження",
    ({ tool, file, cmds }) =>
      (file &&
        ["Edit", "Write", "MultiEdit"].includes(tool) &&
        /prisma\/(schema\.prisma|migrations\/)/.test(rel(file))) ||
      cmds.some((s) => /prisma\s+migrate\s+(dev|deploy)/.test(s)),
  ],
  [
    "W-03",
    "зміна залежностей (npm install <пакет>, package.json) — потрібне підтвердження",
    ({ tool, file, toks }) =>
      (file &&
        ["Edit", "Write", "MultiEdit"].includes(tool) &&
        path.basename(file) === "package.json") ||
      toks.some(
        (t) =>
          ["npm", "pnpm", "yarn"].includes(t[0]) &&
          [
            "install",
            "i",
            "add",
            "uninstall",
            "remove",
            "rm",
            "update",
          ].includes(t[1]) &&
          t.slice(2).some((a) => !a.startsWith("-")),
      ),
  ],
  [
    "W-04",
    "коміт і push робочої гілки — потрібне підтвердження",
    ({ git }) =>
      git.some(
        ({ sub }) =>
          sub === "commit" ||
          sub === "push" ||
          sub === "merge" ||
          sub === "tag",
      ),
  ],
  [
    "W-05",
    "запис у базу знань (ingest_note) — потрібне підтвердження",
    ({ tool, input }) =>
      tool === "mcp__fridge-kb__ingest_note" && !input.dry_run,
  ],
  [
    "W-06",
    "мережевий запит — потрібне підтвердження",
    ({ tool, toks }) =>
      tool === "WebFetch" ||
      toks.some((t) => ["curl", "wget", "http", "nc"].includes(t[0])),
  ],
  [
    "W-07",
    "зміна вимог, guardrails чи інструкцій агента (docs/*-requirements.md, docs/guardrails.md, CLAUDE.md) — потрібне підтвердження",
    ({ tool, file }) =>
      file &&
      ["Edit", "Write", "MultiEdit"].includes(tool) &&
      /^(docs\/(app|harness)-requirements\.md|docs\/guardrails\.md|CLAUDE\.md)$/.test(
        rel(file),
      ),
  ],
];

export function evaluatePre(payload) {
  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};
  const cwd = payload.cwd || PROJECT;
  const file = input.file_path || input.notebook_path || null;
  const cmds =
    tool === "Bash" ? splitCommands(String(input.command ?? "")) : [];
  const toks = cmds.map(tokenize);
  const git = toks.map(gitParts).filter(Boolean);
  const ctx = { tool, input, cwd, file, cmds, toks, git };
  for (const [id, reason, test] of BLOCK)
    if (test(ctx)) return { level: "block", id, reason };
  for (const [id, reason, test] of WARN)
    if (test(ctx)) return { level: "warn", id, reason };
  return { level: "pass" };
}

// ---------------------------------------------------------------- перевірки PostToolUse
export function evaluatePost(payload) {
  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};
  if (["Edit", "Write", "MultiEdit"].includes(tool) && input.file_path) {
    let text = "";
    try {
      text = readFileSync(
        path.resolve(payload.cwd || PROJECT, input.file_path),
        "utf8",
      );
    } catch {
      /* файл міг бути видалений */
    }
    if (SECRET_VALUE.test(text))
      return {
        level: "block",
        id: "P-01",
        reason: `у ${rel(input.file_path)} з'явився рядок, схожий на секрет (токен / ключ). Приберіть його і використовуйте змінну середовища.`,
      };
  }
  if (tool === "Bash") {
    const git = splitCommands(String(input.command ?? ""))
      .map(tokenize)
      .map(gitParts)
      .filter(Boolean);
    if (git.some(({ sub }) => sub === "commit")) {
      let msg = "";
      try {
        msg = execFileSync("git", ["log", "-1", "--format=%s"], {
          cwd: payload.cwd || PROJECT,
          encoding: "utf8",
        }).trim();
      } catch {
        return { level: "pass" };
      }
      if (
        !/^(feat|fix|docs|test|refactor|chore|perf|build|ci|style|revert)(\([\w./-]+\))?!?: .+/.test(
          msg,
        )
      ) {
        return {
          level: "block",
          id: "P-02",
          reason: `повідомлення коміту "${msg}" не відповідає Conventional Commits (тип(область): опис). Виправте його через git commit --amend -m "..."`,
        };
      }
    }
  }
  return { level: "pass" };
}

// ---------------------------------------------------------------- точка входу
function log(entry) {
  try {
    const dir = path.join(PROJECT, ".claude", "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, "guardrails.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch {
    /* журнал не є критичним */
  }
}

function summarize(p) {
  const i = p.tool_input ?? {};
  return (
    i.command ??
    i.file_path ??
    i.path ??
    i.url ??
    (i.title ? `${i.type}:${i.title}` : "")
  );
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // fail-closed: нерозбірний вхід PreToolUse блокує дію
    if (MODE === "pre") {
      process.stderr.write("guardrails: не вдалося розібрати вхід hook-а");
      process.exit(2);
    }
    process.exit(0);
  }
  const r = MODE === "pre" ? evaluatePre(payload) : evaluatePost(payload);
  log({
    event: MODE,
    session: payload.session_id,
    tool: payload.tool_name,
    target: String(summarize(payload)).slice(0, 300),
    level: r.level,
    rule: r.id ?? null,
  });
  if (r.level === "pass") process.exit(0);
  const reason = `[guardrails ${r.id}] ${r.reason}. Див. docs/guardrails.md`;
  const out =
    MODE === "pre"
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: r.level === "block" ? "deny" : "ask",
            permissionDecisionReason: reason,
          },
        }
      : { decision: "block", reason };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

if (process.argv[1] && path.basename(process.argv[1]) === "guardrails.mjs") {
  main().catch((e) => {
    process.stderr.write(`guardrails: внутрішня помилка ${e?.message}`);
    process.exit(MODE === "pre" ? 2 : 0);
  });
}
