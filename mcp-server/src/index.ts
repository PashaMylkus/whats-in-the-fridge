#!/usr/bin/env node
// MCP-сервер fridge-kb: конектор між репозиторієм застосунку «Що в холодильнику»
// і окремим репозиторієм бази знань (Obsidian vault). Транспорт — stdio;
// сервер запускає сама агентна IDE за конфігурацією .mcp.json.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { KbError, KnowledgeBase } from './kb.js';
import { NOTE_TYPES } from './schema.js';

const cfg = loadConfig();
const kb = new KnowledgeBase(cfg);
const server = new McpServer({ name: 'fridge-kb', version: '0.1.0' });

type Result = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

async function handle(fn: () => Promise<object>): Promise<Result> {
  try {
    const data = (await fn()) as Record<string, unknown>;
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  } catch (e) {
    const msg = e instanceof KbError ? e.message : `Внутрішня помилка: ${(e as Error).message}`;
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
}

server.registerTool(
  'vault_status',
  {
    title: 'Стан бази знань',
    description: 'Повертає стан клону vault: поточний коміт, гілку, чи є незакомічені зміни, кількість нотаток за типами.',
    annotations: { readOnlyHint: true },
  },
  () => handle(() => kb.status()),
);

server.registerTool(
  'search_notes',
  {
    title: 'Пошук нотаток',
    description:
      'Повнотекстовий пошук у базі знань застосунку «Що в холодильнику» за назвою, псевдонімами (aliases), тегами, id і полями frontmatter (наприклад хеш коміту) та текстом нотаток. ' +
      'Використовуйте перед зміною коду, щоб знайти поняття, компоненти та архітектурні рішення, і перед ingest_note — щоб не створити дублікат.',
    inputSchema: {
      query: z.string().min(2).describe('Слова для пошуку, наприклад "термін придатності" або "auth"'),
      type: z.enum(NOTE_TYPES).optional().describe('Обмежити пошук типом нотатки'),
      limit: z.number().int().min(1).max(50).optional().describe('Максимум результатів (типово 10)'),
    },
    annotations: { readOnlyHint: true },
  },
  (args) => handle(() => kb.searchNotes(args)),
);

server.registerTool(
  'get_note',
  {
    title: 'Отримати нотатку',
    description: 'Повертає нотатку за id (наприклад "concept-freshness-status") або точною назвою: frontmatter, текст, вихідні посилання та зворотні посилання (backlinks).',
    inputSchema: {
      id: z.string().optional().describe('id з frontmatter'),
      title: z.string().optional().describe('Назва нотатки (назва файлу без .md)'),
    },
    annotations: { readOnlyHint: true },
  },
  (args) =>
    handle(async () => {
      if (!args.id && !args.title) throw new KbError('Вкажіть id або title');
      return kb.getNote(args);
    }),
);

server.registerTool(
  'ingest_note',
  {
    title: 'Записати нотатку в базу знань',
    description:
      'Створює або оновлює нотатку у vault за конвенціями (frontmatter, папка за типом, wiki-посилання), додає її в MOC-Застосунок, ' +
      'робить git commit і push у репозиторій vault. Ідемпотентний: нотатка шукається за id, потім за назвою; повторний виклик з тими самими даними ' +
      'повертає status "unchanged" і не створює коміт. Для завершених задач і комітів використовуйте type "change" (для коміту передайте fields.commit — id буде change-<sha7>). ' +
      'Усі [[посилання]] у content і links мають вказувати на наявні нотатки.',
    inputSchema: {
      type: z.enum(NOTE_TYPES).describe('concept | component | decision | glossary | change'),
      title: z.string().min(2).max(120).describe('Коротка змістовна назва українською (для change — що зроблено, а не текст повідомлення коміту); без символів \\ / : * ? " < > | # ^ [ ]; для decision префікс ADR-NNNN додається автоматично'),
      content: z.string().min(10).describe('Текст нотатки у Markdown без frontmatter і без заголовка першого рівня'),
      id: z.string().optional().describe('Стабільний id <type>-<slug>; якщо не задано — генерується з назви'),
      aliases: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      status: z.string().optional().describe('Статус за типом: concept/glossary — active; component — planned|in-progress|implemented; decision — proposed|accepted; change — done'),
      links: z.array(z.string()).optional().describe('Назви пов\'язаних нотаток; ті, що ще не згадані в content, додаються в розділ «Зв\'язки»'),
      fields: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Поля типу: component — layer, path, implements, depends_on; decision — date, deciders, supersedes; change — kind (feature|fix|docs|refactor|test|chore), date, commit, pr, affects; concept — requirements; glossary — term_en'),
      source: z.string().optional().describe('Першоджерело репозиторій@коміт:шлях; типово — поточний коміт репозиторію застосунку'),
      dry_run: z.boolean().optional().describe('Лише показати, що буде зроблено, без запису й коміту'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  (args) => handle(() => kb.ingestNote(args)),
);

await server.connect(new StdioServerTransport());
console.error(`fridge-kb: vault=${cfg.vaultPath}, push=${cfg.gitPush}`);
