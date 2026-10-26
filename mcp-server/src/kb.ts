import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { commitFiles, git, headShort, pullFastForward, push } from './git.js';
import {
  COMMON_FIELDS, ENUMS, FORBIDDEN_TITLE_CHARS, LINK_FIELDS, NoteType, ROOT_MOC, RULES, TRAILING_FIELDS, slugify,
} from './schema.js';
import { Frontmatter, Note, VaultIndex, extractLinks, loadNotes, parseNote, serializeNote } from './vault.js';

export class KbError extends Error {}

export interface IngestInput {
  type: NoteType;
  title: string;
  content: string;
  id?: string;
  aliases?: string[];
  tags?: string[];
  status?: string;
  links?: string[];
  fields?: Record<string, unknown>;
  source?: string;
  dry_run?: boolean;
}

export interface IngestResult {
  status: 'created' | 'updated' | 'unchanged';
  id: string;
  title: string;
  path: string;
  moc_updated: boolean;
  commit: string | null;
  pushed: boolean;
  warnings: string[];
}

const today = () => new Date().toISOString().slice(0, 10);

/** Порівняння без урахування поля updated: зміна лише дати не є зміною нотатки. */
const comparable = (text: string) => text.replace(/^updated: .*$/m, '');

export class KnowledgeBase {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: Config) {}

  /** Записи виконуються послідовно, щоб паралельні виклики не конфліктували в git. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async index(): Promise<VaultIndex> {
    return new VaultIndex(await loadNotes(this.cfg.vaultPath));
  }

  // ------------------------------------------------------------------ retrieval
  async getNote(ref: { id?: string; title?: string }) {
    const idx = await this.index();
    const note = (ref.id && idx.byId.get(ref.id)) || (ref.title && idx.resolve(ref.title)) || undefined;
    if (!note) throw new KbError(`Нотатку не знайдено: ${ref.id ?? ref.title}`);
    const links = extractLinks(note.body, note.fm);
    return {
      id: String(note.fm.id), title: note.name, type: String(note.fm.type), status: String(note.fm.status),
      path: note.rel, frontmatter: note.fm, body: note.body.trim(),
      links_out: links.filter((l) => idx.resolve(l)).map((l) => idx.resolve(l)!.name),
      backlinks: idx.backlinks(note.name).map((n) => n.name),
    };
  }

  async searchNotes(q: { query: string; type?: string; limit?: number }) {
    const idx = await this.index();
    const terms = q.query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    if (!terms.length) throw new KbError('Порожній запит');
    const results = idx.notes
      .filter((n) => !q.type || n.fm.type === q.type)
      .map((n) => {
        const title = n.name.toLowerCase();
        const aliases = ((n.fm.aliases as string[]) ?? []).join(' ').toLowerCase();
        const tags = ((n.fm.tags as string[]) ?? []).join(' ').toLowerCase();
        const body = n.body.toLowerCase();
        let score = 0;
        const phrase = terms.join(' ');
        const normTitle = title.replace(/[-_]+/g, ' ');
        if (normTitle === phrase) score += 20;
        else if (normTitle.startsWith(phrase)) score += 8;
        for (const t of terms) {
          if (title === t) score += 10;
          else if (title.includes(t)) score += 5;
          if (aliases.includes(t)) score += 4;
          if (tags.includes(t)) score += 2;
          score += Math.min(body.split(t).length - 1, 5);
        }
        const pos = body.indexOf(terms[0]);
        const snippet = pos >= 0 ? n.body.slice(Math.max(0, pos - 60), pos + 120).replace(/\s+/g, ' ').trim() : '';
        return { id: String(n.fm.id), title: n.name, type: String(n.fm.type), status: String(n.fm.status), path: n.rel, score, snippet };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'uk'))
      .slice(0, q.limit ?? 10);
    return { query: q.query, total: results.length, results };
  }

  async status() {
    const idx = await this.index();
    const byType: Record<string, number> = {};
    for (const n of idx.notes) byType[String(n.fm.type)] = (byType[String(n.fm.type)] ?? 0) + 1;
    const dirty = await git(this.cfg.vaultPath, 'status', '--porcelain');
    return {
      vault_path: this.cfg.vaultPath,
      head: await headShort(this.cfg.vaultPath),
      branch: await git(this.cfg.vaultPath, 'rev-parse', '--abbrev-ref', 'HEAD'),
      clean: dirty === '',
      notes: idx.notes.length,
      by_type: byType,
    };
  }

  // ------------------------------------------------------------------ ingestion
  ingestNote(input: IngestInput): Promise<IngestResult> {
    return this.serial(() => this.doIngest(input));
  }

  private async doIngest(input: IngestInput): Promise<IngestResult> {
    const cfg = this.cfg;
    const rule = RULES[input.type];
    const warnings: string[] = [];
    if (cfg.gitPull && !input.dry_run) {
      try {
        await pullFastForward(cfg.vaultPath);
      } catch (e) {
        throw new KbError(`git pull --ff-only не вдався (локальний клон vault розійшовся з origin): ${(e as Error).message.split('\n')[0]}`);
      }
    }
    const idx = await this.index();

    // 1. Назва і пошук наявної нотатки (ідемпотентність: id → назва → для ADR назва без префікса)
    let title = input.title.trim().replace(/\s+/g, ' ');
    if (FORBIDDEN_TITLE_CHARS.test(title)) throw new KbError(`Назва містить заборонені символи \\ / : * ? " < > | # ^ [ ]: "${title}"`);
    const fields = { ...(input.fields ?? {}) };
    const commitSha = typeof fields.commit === 'string' ? fields.commit.slice(0, 7) : undefined;
    let id = input.id ?? (input.type === 'change' && commitSha ? `change-${commitSha}` : undefined);

    let existing: Note | undefined = (id && idx.byId.get(id)) || idx.resolve(title);
    if (!existing && input.type === 'decision') {
      existing = idx.notes.find((n) => n.fm.type === 'decision' && n.name.replace(/^ADR-\d{4} /, '') === title.replace(/^ADR-\d{4} /, ''));
    }
    if (existing && existing.fm.type !== input.type) {
      throw new KbError(`Нотатка "${existing.name}" вже існує з типом ${existing.fm.type}, а не ${input.type}`);
    }
    if (existing) {
      if (id && existing.fm.id !== id) warnings.push(`Знайдено нотатку за назвою з іншим id (${existing.fm.id}); id збережено`);
      id = String(existing.fm.id);
      title = existing.name;
    }

    // 2. Номер і назва ADR
    if (input.type === 'decision') {
      const m = title.match(/^ADR-(\d{4}) /);
      if (existing) fields.adr = existing.fm.adr;
      else if (m) fields.adr = Number(m[1]);
      else {
        const max = Math.max(0, ...idx.notes.filter((n) => n.fm.type === 'decision').map((n) => Number(n.fm.adr) || 0));
        fields.adr = (typeof fields.adr === 'number' ? fields.adr : max + 1);
      }
      const prefix = `ADR-${String(fields.adr).padStart(4, '0')} `;
      if (!title.startsWith(prefix)) title = prefix + title.replace(/^ADR-\d{4} /, '');
      id ??= `adr-${String(fields.adr).padStart(4, '0')}`;
    }
    id ??= `${input.type}-${slugify(title)}`;
    if (!/^[a-z]+-[a-z0-9-]+$/.test(id)) throw new KbError(`Некоректний id "${id}" (очікується <type>-<slug> латиницею)`);
    const clash = idx.byId.get(id);
    if (clash && clash !== existing) throw new KbError(`id "${id}" вже використовує нотатка "${clash.name}"`);

    // 3. Поля, специфічні для типу
    const unknown = Object.keys(fields).filter((k) => !(k in rule.fields));
    if (unknown.length) throw new KbError(`Поля ${unknown.join(', ')} не передбачені для типу ${input.type}; допустимі: ${Object.keys(rule.fields).join(', ')}`);
    const typed: Frontmatter = {};
    for (const [k, def] of Object.entries(rule.fields)) {
      let v = k in fields ? fields[k] : existing && k in existing.fm ? existing.fm[k] : def;
      if (k === 'date' && v === null) v = today();
      if (k === 'commit' && typeof v === 'string') v = v.slice(0, 7);
      if (LINK_FIELDS.includes(k)) v = Array.isArray(v) ? v.map(toLink) : v === null ? null : toLink(String(v));
      if (ENUMS[k] && !ENUMS[k].includes(String(v))) throw new KbError(`Поле ${k}: недопустиме значення "${v}"; допустимі: ${ENUMS[k].join(', ')}`);
      typed[k] = v;
    }
    const status = input.status ?? (existing?.fm.status as string | undefined) ?? rule.defaultStatus;
    if (!rule.statuses.includes(status)) throw new KbError(`status "${status}" недопустимий для ${input.type}; допустимі: ${rule.statuses.join(', ')}`);

    // 4. Тіло нотатки: заголовок + вміст + розділ «Зв'язки»
    let content = input.content.trim().replace(/^# .*\n+/, '');
    const inline = new Set(extractLinks(content).map((l) => l.toLowerCase()));
    const extra = (input.links ?? []).filter((l) => !inline.has(l.toLowerCase()));
    if (extra.length) {
      content += (/^## Зв'язки/m.test(content) ? '\n' : "\n\n## Зв'язки\n\n") + extra.map((l) => `- [[${l}]]`).join('\n');
    }
    const body = `# ${title}\n\n${content}\n`;

    const aliases = uniq([...(input.aliases ?? (existing?.fm.aliases as string[]) ?? [])]);
    const tags = uniq([input.type, ...(input.tags ?? (existing?.fm.tags as string[]) ?? [])]);
    const appHead = await headShort(cfg.appPath);
    const source = input.source ??
      (existing?.fm.source as string | undefined) ??
      `${cfg.appRepoName}@${commitSha ?? appHead ?? 'unknown'}:${typeof typed.path === 'string' ? typed.path : ''}`;

    const fm: Frontmatter = {};
    const common: Frontmatter = { id, type: input.type, title, aliases, tags, status };
    for (const k of COMMON_FIELDS) fm[k] = common[k];
    Object.assign(fm, typed);
    const trailing: Frontmatter = { source, created: existing?.fm.created ?? today(), updated: today() };
    for (const k of TRAILING_FIELDS) fm[k] = trailing[k];

    // 5. Усі посилання мають розв'язуватися — vault залишається валідним
    const unresolved = extractLinks(body, fm).filter((l) => l.toLowerCase() !== title.toLowerCase() && !idx.resolve(l));
    if (unresolved.length) throw new KbError(`Нерозв'язні посилання: ${unresolved.map((l) => `[[${l}]]`).join(', ')}. Створіть ці нотатки або виправте назви (див. search_notes).`);

    const rel = existing?.rel ?? path.join(rule.folder, `${title}.md`);
    const abs = path.join(cfg.vaultPath, rel);
    if (!abs.startsWith(cfg.vaultPath + path.sep)) throw new KbError('Шлях нотатки виходить за межі vault');
    const text = serializeNote(fm, body);
    if (existing && comparable(existing.raw) === comparable(text)) {
      return { status: 'unchanged', id, title, path: rel, moc_updated: false, commit: null, pushed: false, warnings };
    }

    // 6. Посилання з MOC, щоб нова нотатка була досяжною
    const mocNote = idx.byName.get(ROOT_MOC);
    let mocText: string | null = null;
    if (!existing) {
      if (!mocNote) warnings.push(`${ROOT_MOC} не знайдено — нотатка буде недосяжною з MOC`);
      else if (!extractLinks(mocNote.body).some((l) => l.toLowerCase() === title.toLowerCase())) {
        mocText = addToMoc(mocNote.raw, rule.mocSection, title);
      }
    }
    const result: IngestResult = {
      status: existing ? 'updated' : 'created', id, title, path: rel, moc_updated: mocText !== null, commit: null, pushed: false, warnings,
    };
    if (input.dry_run) return result;

    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, text, 'utf8');
    const files = [rel];
    if (mocText !== null && mocNote) {
      await writeFile(path.join(cfg.vaultPath, mocNote.rel), mocText, 'utf8');
      files.push(mocNote.rel);
    }
    result.commit = await commitFiles(cfg.vaultPath, files, `kb(${input.type}): ${result.status} ${id}`);
    if (cfg.gitPush && result.commit) {
      const p = await push(cfg.vaultPath);
      result.pushed = p.pushed;
      if (!p.pushed) warnings.push(`push не виконано: ${p.error}`);
    }
    return result;
  }
}

function toLink(v: string): string {
  return v.startsWith('[[') ? v : `[[${v}]]`;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Додає "- [[title]]" у кінець розділу MOC (створює розділ, якщо його немає). */
export function addToMoc(raw: string, section: string, title: string): string {
  const lines = raw.replace(/\n+$/, '').split('\n');
  const start = lines.findIndex((l) => l.trim() === section);
  const item = `- [[${title}]]`;
  if (start === -1) return `${lines.join('\n')}\n\n${section}\n\n${item}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  const block = lines[insertAt - 1]?.startsWith('- ') ? [item] : ['', item];
  lines.splice(insertAt, 0, ...block);
  return lines.join('\n') + '\n';
}

export async function readNoteFile(p: string) {
  return parseNote(await readFile(p, 'utf8'));
}
