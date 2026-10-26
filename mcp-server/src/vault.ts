import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export type Frontmatter = Record<string, unknown>;

export interface Note {
  /** Назва файлу без .md — саме за нею працюють [[посилання]]. */
  name: string;
  /** Шлях відносно кореня vault. */
  rel: string;
  fm: Frontmatter;
  body: string;
  raw: string;
}

const IGNORE_DIRS = new Set(['.git', '.obsidian', 'tools', 'Templates', 'node_modules']);
const IGNORE_FILES = new Set(['README.md']);
const FM_RE = /^---\n([\s\S]*?)\n---\n/;

export function parseNote(raw: string): { fm: Frontmatter | null; body: string } {
  const m = raw.match(FM_RE);
  if (!m) return { fm: null, body: raw };
  const fm = YAML.parse(m[1]) as Frontmatter;
  return { fm: fm ?? {}, body: raw.slice(m[0].length) };
}

// Серіалізація у тому самому стилі, що й первинні нотатки (ПР № 2):
// скаляри без лапок, списки у flow-стилі, лапки лише за потреби.
function yamlValue(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(yamlValue).join(', ') + ']';
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  const needsQuotes =
    s === '' || s.startsWith('[[') || /[:#,[\]{}]/.test(s) || /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(s) ||
    /^[\s'"&*!|>%@`-]/.test(s);
  return needsQuotes ? JSON.stringify(s) : s;
}

export function serializeNote(fm: Frontmatter, body: string): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return ['---', ...lines, '---', '', body.trim(), ''].join('\n');
}

const LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Wiki-посилання з тексту (без блоків коду) і frontmatter. */
export function extractLinks(body: string, fm: Frontmatter = {}): string[] {
  const clean = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const fmText = Object.values(fm).flat().filter((v) => typeof v === 'string').join(' ');
  return [...new Set([...`${clean} ${fmText}`.matchAll(LINK_RE)].map((m) => m[1].trim()))];
}

export async function loadNotes(root: string): Promise<Note[]> {
  const out: Note[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) await walk(abs);
      } else if (entry.name.endsWith('.md') && !IGNORE_FILES.has(entry.name)) {
        const raw = await readFile(abs, 'utf8');
        const { fm, body } = parseNote(raw);
        out.push({ name: entry.name.slice(0, -3), rel: path.relative(root, abs), fm: fm ?? {}, body, raw });
      }
    }
  }
  await walk(root);
  return out;
}

export class VaultIndex {
  readonly byName = new Map<string, Note>();
  readonly byId = new Map<string, Note>();
  private readonly lower = new Map<string, string>();

  constructor(readonly notes: Note[]) {
    for (const n of notes) {
      this.byName.set(n.name, n);
      this.lower.set(n.name.toLowerCase(), n.name);
      if (typeof n.fm.id === 'string') this.byId.set(n.fm.id, n);
    }
  }

  /** Розв'язання посилання так, як це робить Obsidian (без урахування регістру). */
  resolve(target: string): Note | undefined {
    return this.byName.get(target) ?? this.byName.get(this.lower.get(target.toLowerCase()) ?? '');
  }

  backlinks(name: string): Note[] {
    return this.notes.filter((n) => n.name !== name && extractLinks(n.body, n.fm).some((l) => this.resolve(l)?.name === name));
  }
}
