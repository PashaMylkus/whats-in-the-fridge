// Тест-кейси guardrails (docs/guardrails.md, розділ «Тест-кейси»).
// Запуск: node --test '.claude/hooks/*.test.mjs'
// Hook викликається так само, як його викликає Claude Code: окремий процес, JSON на stdin.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const HOOK = path.join(import.meta.dirname, 'guardrails.mjs');
const PRECOMMIT = path.join(import.meta.dirname, '..', '..', '.githooks');
let root, app;

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '' } }).trim();

function hook(mode, payload) {
  const r = spawnSync(process.execPath, [HOOK, mode], {
    input: JSON.stringify({ session_id: 'test', cwd: app, ...payload }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: app },
    encoding: 'utf8',
  });
  if (r.status === 2) return { decision: 'deny', reason: r.stderr };
  if (!r.stdout) return { decision: 'pass' };
  const out = JSON.parse(r.stdout);
  if (mode === 'pre') return { decision: out.hookSpecificOutput.permissionDecision, reason: out.hookSpecificOutput.permissionDecisionReason };
  return { decision: out.decision, reason: out.reason };
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-'));
  app = path.join(root, 'whats-in-the-fridge');
  mkdirSync(path.join(root, 'whats-in-the-fridge-vault', 'Decisions'), { recursive: true });
  mkdirSync(app);
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'config', 'user.name', 'Test');
  git(app, 'config', 'user.email', 'test@example.com');
  writeFileSync(path.join(app, 'README.md'), 'app\n');
  git(app, 'add', '-A');
  git(app, 'commit', '-qm', 'chore: init');
});
after(() => rmSync(root, { recursive: true, force: true }));

const onBranch = (b) => git(app, 'switch', '-q', ...(git(app, 'branch', '--list', b) ? [b] : ['-c', b]));

// [id, правило, сценарій, payload, очікуване рішення]
const PRE = [
  // ----- allow: hook мовчить, далі діють permissions.allow
  ['TC-A1', 'A-01', 'читання коду застосунку', { tool_name: 'Read', tool_input: { file_path: 'apps/api/src/index.ts' } }, 'pass'],
  ['TC-A2', 'A-02', 'read-only git у складеній команді', { tool_name: 'Bash', tool_input: { command: 'git status && git log --oneline -5' } }, 'pass'],
  ['TC-A3', 'A-03', 'запуск тестів', { tool_name: 'Bash', tool_input: { command: 'npm test' } }, 'pass'],
  ['TC-A4', 'A-04', 'пошук у базі знань через MCP', { tool_name: 'mcp__fridge-kb__search_notes', tool_input: { query: 'термін придатності' } }, 'pass'],
  ['TC-A5', 'A-05', 'створення робочої гілки', { tool_name: 'Bash', tool_input: { command: 'git switch -c feature/products-crud' } }, 'pass'],
  ['TC-A6', 'A-04', 'пробний запис у vault (dry_run)', { tool_name: 'mcp__fridge-kb__ingest_note', tool_input: { type: 'change', title: 'X', content: 'xxxxxxxxxx', dry_run: true } }, 'pass'],
  ['TC-A7', 'A-01', 'читання шаблону .env.example', { tool_name: 'Read', tool_input: { file_path: '.env.example' } }, 'pass'],
  ['TC-A8', 'A-03', 'очищення артефактів збірки', { tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules dist' } }, 'pass'],
  // ----- warn: потрібне підтвердження людини
  ['TC-W1', 'W-01', 'зміна доменного ядра', { tool_name: 'Edit', tool_input: { file_path: 'packages/shared/src/domain/freshness.ts', old_string: 'a', new_string: 'b' } }, 'ask'],
  ['TC-W2', 'W-02', 'нова міграція БД', { tool_name: 'Bash', tool_input: { command: 'npx prisma migrate dev --name add_products' } }, 'ask'],
  ['TC-W3', 'W-03', 'нова залежність', { tool_name: 'Bash', tool_input: { command: 'npm install zod' } }, 'ask'],
  ['TC-W4', 'W-04', 'коміт у робочій гілці', { tool_name: 'Bash', tool_input: { command: 'git commit -m "feat(products): crud"' }, branch: 'feature/products-crud' }, 'ask'],
  ['TC-W5', 'W-05', 'запис у базу знань', { tool_name: 'mcp__fridge-kb__ingest_note', tool_input: { type: 'change', title: 'X', content: 'xxxxxxxxxx' } }, 'ask'],
  ['TC-W6', 'W-06', 'мережевий запит', { tool_name: 'Bash', tool_input: { command: 'curl -s https://example.com' } }, 'ask'],
  ['TC-W7', 'W-07', 'зміна guardrails', { tool_name: 'Edit', tool_input: { file_path: 'docs/guardrails.md', old_string: 'a', new_string: 'b' } }, 'ask'],
  // ----- block: заборонено безумовно
  ['TC-B1', 'B-01', 'читання .env', { tool_name: 'Read', tool_input: { file_path: '.env' } }, 'deny'],
  ['TC-B2', 'B-01', 'секрет через підстановку команди', { tool_name: 'Bash', tool_input: { command: 'echo "$(cat .env)" | head' } }, 'deny'],
  ['TC-B3', 'B-02', 'читання vault напряму', { tool_name: 'Read', tool_input: { file_path: '../whats-in-the-fridge-vault/Concepts/Продукт.md' } }, 'deny'],
  ['TC-B4', 'B-02', 'видалення ADR у vault через bash', { tool_name: 'Bash', tool_input: { command: 'rm ../whats-in-the-fridge-vault/Decisions/ADR-0001.md' } }, 'deny'],
  ['TC-B5', 'B-03', 'force-push', { tool_name: 'Bash', tool_input: { command: 'cd apps && git push -f origin feature/x' } }, 'deny'],
  ['TC-B6', 'B-03', 'push у main', { tool_name: 'Bash', tool_input: { command: 'git push origin HEAD:main' }, branch: 'feature/products-crud' }, 'deny'],
  ['TC-B7', 'B-04', 'коміт напряму в main', { tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m "fix: x"' }, branch: 'main' }, 'deny'],
  ['TC-B8', 'B-04', 'обхід git-хуків', { tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m "fix: x"' }, branch: 'feature/products-crud' }, 'deny'],
  ['TC-B9', 'B-05', 'reset --hard через обгортку', { tool_name: 'Bash', tool_input: { command: 'timeout 5 git reset --hard HEAD~1' } }, 'deny'],
  ['TC-B10', 'B-06', 'рекурсивне видалення коду', { tool_name: 'Bash', tool_input: { command: 'rm -rf apps/api/src' } }, 'deny'],
  ['TC-B11', 'B-07', 'скидання БД', { tool_name: 'Bash', tool_input: { command: 'npx prisma migrate reset --force' } }, 'deny'],
  ['TC-B12', 'B-08', 'зміна settings.json', { tool_name: 'Edit', tool_input: { file_path: '.claude/settings.json', old_string: 'a', new_string: 'b' } }, 'deny'],
  ['TC-B13', 'B-08', 'перезапис .mcp.json через bash', { tool_name: 'Bash', tool_input: { command: "echo '{}' > .mcp.json" } }, 'deny'],
  ['TC-B14', 'B-08', 'вимкнення git-хуків', { tool_name: 'Bash', tool_input: { command: 'git config core.hooksPath /dev/null' } }, 'deny'],
  ['TC-B15', 'B-09', 'додавання .only у тест', { tool_name: 'Edit', tool_input: { file_path: 'apps/api/src/products.test.ts', old_string: "it('lists'", new_string: "it.only('lists'" } }, 'deny'],
  ['TC-B16', 'B-10', 'публікація пакета', { tool_name: 'Bash', tool_input: { command: 'npm publish' } }, 'deny'],
];

describe('PreToolUse guardrails', () => {
  for (const [id, rule, scenario, payload, expected] of PRE) {
    test(`${id} ${rule} — ${scenario} → ${expected}`, () => {
      if (payload.branch) onBranch(payload.branch); else onBranch('main');
      const { branch, ...p } = payload;
      const r = hook('pre', p);
      assert.equal(r.decision, expected, r.reason);
      if (expected !== 'pass') assert.match(r.reason, new RegExp(`\\[guardrails ${rule}\\]`));
    });
  }
});

describe('PostToolUse guardrails', () => {
  test('TC-P1 P-01 — у записаному файлі з\'явився токен → block', () => {
    mkdirSync(path.join(app, 'apps'), { recursive: true });
    writeFileSync(path.join(app, 'apps', 'config.ts'), 'export const token = "ghp_' + 'a'.repeat(36) + '";\n');
    const r = hook('post', { tool_name: 'Write', tool_input: { file_path: 'apps/config.ts' } });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /P-01/);
  });
  test('TC-P2 P-02 — коміт без Conventional Commits → block', () => {
    onBranch('feature/p2');
    writeFileSync(path.join(app, 'a.txt'), 'a');
    git(app, 'add', 'a.txt');
    git(app, 'commit', '-qm', 'update stuff');
    const r = hook('post', { tool_name: 'Bash', tool_input: { command: 'git commit -m "update stuff"' } });
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /P-02/);
  });
  test('TC-P3 — коректний коміт → pass', () => {
    writeFileSync(path.join(app, 'b.txt'), 'b');
    git(app, 'add', 'b.txt');
    git(app, 'commit', '-qm', 'docs: add b');
    assert.equal(hook('post', { tool_name: 'Bash', tool_input: { command: 'git commit -m "docs: add b"' } }).decision, 'pass');
  });
});

describe('git pre-commit (.githooks)', () => {
  let repo;
  before(() => {
    repo = path.join(root, 'precommit');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    cpSync(PRECOMMIT, path.join(repo, '.githooks'), { recursive: true });
    git(repo, 'config', 'core.hooksPath', '.githooks');
    writeFileSync(path.join(repo, 'README.md'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'chore: init');
  });
  const commit = (env) => spawnSync('git', ['commit', '-qm', 'test: x'], { cwd: repo, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '', ...env } });

  test('TC-G1 B-01 — .env не потрапляє в коміт', () => {
    writeFileSync(path.join(repo, '.env'), 'JWT_SECRET=x\n');
    git(repo, 'add', '-f', '.env');
    const r = commit();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /B-01/);
    git(repo, 'rm', '-q', '--cached', '.env');
  });
  test('TC-G2 B-09 — it.only відхиляється навіть для людини', () => {
    writeFileSync(path.join(repo, 'a.test.ts'), "it.only('x', () => {});\n");
    git(repo, 'add', 'a.test.ts');
    const r = commit();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /B-09/);
    git(repo, 'rm', '-q', '--cached', 'a.test.ts');
  });
  test('TC-G3 B-04 — агент (CLAUDECODE=1) не комітить у main, людина — може', () => {
    writeFileSync(path.join(repo, 'ok.txt'), 'ok\n');
    git(repo, 'add', 'ok.txt');
    const agent = commit({ CLAUDECODE: '1' });
    assert.notEqual(agent.status, 0);
    assert.match(agent.stderr, /B-04/);
    assert.equal(commit().status, 0);
  });
  test('TC-G4 B-08 — агент не комітить зміни hooks навіть у робочій гілці', () => {
    git(repo, 'switch', '-q', '-c', 'feature/x');
    writeFileSync(path.join(repo, '.githooks', 'pre-commit.mjs'), readFileSync(path.join(repo, '.githooks', 'pre-commit.mjs'), 'utf8') + '\n// off\n');
    git(repo, 'add', '.githooks');
    const r = commit({ CLAUDECODE: '1' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /B-08/);
  });
});
