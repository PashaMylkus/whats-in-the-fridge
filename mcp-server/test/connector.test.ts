// Інтеграційні тести MCP-сервера fridge-kb: сервер запускається як окремий процес
// і викликається через MCP-клієнт по stdio — так само, як його викликає агентна IDE.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const gitInit = (dir: string) => {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
};

let tmp: string, vault: string, remote: string, app: string, client: Client;

type ToolResult = { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
const commits = () => Number(git(vault, 'rev-list', '--count', 'HEAD'));

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'fridge-kb-'));
  remote = path.join(tmp, 'remote.git');
  vault = path.join(tmp, 'vault');
  app = path.join(tmp, 'app');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  cpSync(path.join(here, 'fixtures', 'vault'), vault, { recursive: true });
  gitInit(vault);
  git(vault, 'add', '-A');
  git(vault, 'commit', '-qm', 'init');
  git(vault, 'remote', 'add', 'origin', remote);
  git(vault, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('mkdir', ['-p', app]);
  gitInit(app);
  writeFileSync(path.join(app, 'README.md'), 'app');
  git(app, 'add', '-A');
  git(app, 'commit', '-qm', 'app init');

  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { ...process.env, VAULT_PATH: vault, APP_PATH: app, APP_REPO_NAME: 'whats-in-the-fridge' } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
});

afterAll(async () => {
  await client?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('fridge-kb MCP server', () => {
  it('надає чотири інструменти з описами та схемами', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_note', 'ingest_note', 'search_notes', 'vault_status']);
    const ingest = tools.find((t) => t.name === 'ingest_note')!;
    expect(ingest.inputSchema.required).toEqual(expect.arrayContaining(['type', 'title', 'content']));
  });

  it('vault_status повертає кількість нотаток', async () => {
    const r = await call('vault_status');
    expect(r.structuredContent.notes).toBe(4);
    expect(r.structuredContent.clean).toBe(true);
  });

  const change = {
    type: 'change',
    title: 'Каркас MCP-сервера fridge-kb',
    content: 'Створено каркас MCP-сервера з інструментами retrieval та ingestion.',
    links: ['MCP-сервер бази знань'],
    fields: { kind: 'feature', commit: 'abcdef1234567', affects: ['MCP-сервер бази знань'] },
  };

  it('ingest_note створює нотатку, додає її в MOC, комітить і пушить', async () => {
    const before = commits();
    const r = await call('ingest_note', change);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: 'created', id: 'change-abcdef1', moc_updated: true, pushed: true });
    expect(commits()).toBe(before + 1);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(vault, 'rev-parse', 'HEAD'));
    const note = readFileSync(path.join(vault, 'Changes', 'Каркас MCP-сервера fridge-kb.md'), 'utf8');
    expect(note).toMatch(/^---\nid: change-abcdef1\ntype: change\n/);
    expect(note).toContain('affects: ["[[MCP-сервер бази знань]]"]');
    expect(note).toContain("## Зв'язки");
    const moc = readFileSync(path.join(vault, 'MOC-Застосунок.md'), 'utf8');
    expect(moc).toContain('## Журнал змін\n\n- [[Каркас MCP-сервера fridge-kb]]');
  });

  it('повторний виклик з тими самими даними — unchanged, без коміту й без дублікату', async () => {
    const before = commits();
    const r = await call('ingest_note', change);
    expect(r.structuredContent).toMatchObject({ status: 'unchanged', commit: null });
    expect(commits()).toBe(before);
    expect(readdirSync(path.join(vault, 'Changes'))).toHaveLength(1);
    const moc = readFileSync(path.join(vault, 'MOC-Застосунок.md'), 'utf8');
    expect(moc.match(/\[\[Каркас MCP-сервера fridge-kb\]\]/g)).toHaveLength(1);
  });

  it('той самий коміт під іншою назвою оновлює наявну нотатку (id change-<sha7>)', async () => {
    const r = await call('ingest_note', { ...change, title: 'Інша назва', content: 'Оновлений опис задачі зі змістом.' });
    expect(r.structuredContent).toMatchObject({ status: 'updated', id: 'change-abcdef1', title: 'Каркас MCP-сервера fridge-kb' });
    expect(readdirSync(path.join(vault, 'Changes'))).toHaveLength(1);
    const note = readFileSync(path.join(vault, 'Changes', 'Каркас MCP-сервера fridge-kb.md'), 'utf8');
    expect(note).toContain('Оновлений опис');
  });

  it('оновлення компонента зберігає created і id', async () => {
    const r = await call('ingest_note', {
      type: 'component', title: 'MCP-сервер бази знань', status: 'implemented',
      content: 'Реалізовано. Пов\'язано з [[Продукт|продуктами]].', fields: { layer: 'harness', path: 'mcp-server' },
    });
    expect(r.structuredContent).toMatchObject({ status: 'updated', id: 'component-mcp-kb-server', moc_updated: false });
    const note = readFileSync(path.join(vault, 'Components', 'MCP-сервер бази знань.md'), 'utf8');
    expect(note).toContain('status: implemented');
    expect(note).toContain('created: 2026-10-26');
    expect(note).toContain('aliases: [fridge-kb]');
  });

  it('decision отримує наступний номер ADR і залишається ідемпотентним без префікса', async () => {
    const adr = { type: 'decision', title: 'TypeScript і stdio для MCP-сервера', content: '## Контекст\n\nПотрібен конектор.\n\n## Рішення\n\nTypeScript + stdio.', fields: { applies_to: ['MCP-сервер бази знань'] } };
    const r1 = await call('ingest_note', adr);
    expect(r1.structuredContent).toMatchObject({ status: 'created', id: 'adr-0002', title: 'ADR-0002 TypeScript і stdio для MCP-сервера' });
    const r2 = await call('ingest_note', adr);
    expect(r2.structuredContent.status).toBe('unchanged');
    expect(readdirSync(path.join(vault, 'Decisions'))).toHaveLength(2);
  });

  it('онтологія: відхиляє відношення з ціллю поза range і рішення без applies_to', async () => {
    const r1 = await call('ingest_note', {
      type: 'component', title: 'MCP-сервер бази знань', content: 'Конектор до vault.',
      fields: { implements: ['ADR-0001 Монорепозиторій на npm workspaces'] },
    });
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toContain('Порушення онтології');
    const r2 = await call('ingest_note', { type: 'decision', title: 'Рішення без цілі', content: 'Контекст і рішення без applies_to.' });
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toContain('applies_to');
  });

  it('get_note повертає типізовані відношення й обернені до них', async () => {
    const g = await call('get_note', { title: 'MCP-сервер бази знань' });
    expect(g.structuredContent.relations.incoming.governed_by).toContain('ADR-0002 TypeScript і stdio для MCP-сервера');
    expect(g.structuredContent.relations.incoming.changed_by).toContain('Каркас MCP-сервера fridge-kb');
  });

  it('відхиляє нерозв\'язні посилання й нічого не записує', async () => {
    const before = commits();
    const r = await call('ingest_note', { type: 'concept', title: 'Рецепт', content: 'Див. [[Неіснуюча нотатка]].' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Нерозв\'язні посилання');
    expect(existsSync(path.join(vault, 'Concepts', 'Рецепт.md'))).toBe(false);
    expect(commits()).toBe(before);
  });

  it('відхиляє назви з шляхом і невідомі поля', async () => {
    const r1 = await call('ingest_note', { type: 'concept', title: '../../etc/passwd', content: 'спроба вийти за межі vault' });
    expect(r1.isError).toBe(true);
    const r2 = await call('ingest_note', { type: 'concept', title: 'Рецепт', content: 'Опис рецепта.', fields: { layer: 'api' } });
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toContain('не передбачені');
  });

  it('перед записом підтягує зміни з origin (git pull --ff-only)', async () => {
    const other = path.join(tmp, 'other');
    execFileSync('git', ['clone', '-q', remote, other]);
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'user.email', 'other@example.com');
    writeFileSync(path.join(other, 'Concepts', 'Продукт.md'), readFileSync(path.join(other, 'Concepts', 'Продукт.md'), 'utf8') + '\nРедаговано в Obsidian.\n');
    git(other, 'commit', '-qam', 'edit from another machine');
    git(other, 'push', '-q');
    const r = await call('ingest_note', { type: 'glossary', title: 'MCP', content: 'Model Context Protocol — протокол інструментів для агентів.', fields: { term_en: 'Model Context Protocol' } });
    expect(r.structuredContent).toMatchObject({ status: 'created', pushed: true });
    expect(readFileSync(path.join(vault, 'Concepts', 'Продукт.md'), 'utf8')).toContain('Редаговано в Obsidian.');
  });

  it('search_notes і get_note читають vault', async () => {
    const s = await call('search_notes', { query: 'mcp сервер' });
    expect(s.structuredContent.results[0].title).toBe('MCP-сервер бази знань');
    const byCommit = await call('search_notes', { query: 'abcdef1', type: 'change' });
    expect(byCommit.structuredContent.results.map((r: any) => r.id)).toEqual(['change-abcdef1']);
    const g = await call('get_note', { id: 'concept-product' });
    expect(g.structuredContent.title).toBe('Продукт');
    expect(g.structuredContent.backlinks).toEqual(expect.arrayContaining(['MOC-Застосунок', 'ADR-0001 Монорепозиторій на npm workspaces']));
    const missing = await call('get_note', { title: 'Немає такої' });
    expect(missing.isError).toBe(true);
  });
});
