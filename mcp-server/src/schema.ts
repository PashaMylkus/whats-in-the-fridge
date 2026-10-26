// Схема нотаток vault. Дзеркалить «Конвенції vault» і tools/validate-vault.mjs
// у репозиторії бази знань.

export const NOTE_TYPES = ['concept', 'component', 'decision', 'glossary', 'change'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export interface TypeRule {
  folder: string;
  statuses: string[];
  defaultStatus: string;
  /** Поля, специфічні для типу, з типовими значеннями. */
  fields: Record<string, unknown>;
  /** Розділ MOC-Застосунок, куди додається посилання на нову нотатку. */
  mocSection: string;
}

export const COMMON_FIELDS = ['id', 'type', 'title', 'aliases', 'tags', 'status'] as const;
export const TRAILING_FIELDS = ['source', 'created', 'updated'] as const;

export const RULES: Record<NoteType, TypeRule> = {
  concept: {
    folder: 'Concepts', statuses: ['active', 'deprecated'], defaultStatus: 'active',
    fields: { requirements: [] }, mocSection: '## Концепції предметної області',
  },
  component: {
    folder: 'Components', statuses: ['planned', 'in-progress', 'implemented', 'deprecated'], defaultStatus: 'planned',
    fields: { layer: 'api', path: '', implements: [], depends_on: [] }, mocSection: '## Компоненти застосунку',
  },
  decision: {
    folder: 'Decisions', statuses: ['proposed', 'accepted', 'superseded', 'deprecated'], defaultStatus: 'accepted',
    fields: { adr: null, date: null, deciders: [], supersedes: null }, mocSection: '## Архітектурні рішення',
  },
  glossary: {
    folder: 'Glossary', statuses: ['active', 'deprecated'], defaultStatus: 'active',
    fields: { term_en: '' }, mocSection: '## Глосарій',
  },
  change: {
    folder: 'Changes', statuses: ['done'], defaultStatus: 'done',
    fields: { kind: 'feature', date: null, commit: null, pr: null, affects: [] }, mocSection: '## Журнал змін',
  },
};

export const ENUMS: Record<string, string[]> = {
  layer: ['web', 'api', 'shared', 'db', 'harness'],
  kind: ['feature', 'fix', 'docs', 'refactor', 'test', 'chore'],
};

/** Поля, значення яких — wiki-посилання ("[[Назва]]"). */
export const LINK_FIELDS = ['depends_on', 'affects', 'supersedes'];

export const ROOT_MOC = 'MOC-Застосунок';

/** Символи, заборонені в назві нотатки (файлова система + синтаксис посилань Obsidian). */
export const FORBIDDEN_TITLE_CHARS = /[\\/:*?"<>|#^[\]]/;

const UA: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i',
  й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh',
  ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', "'": '', '’': '',
};

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .split('')
    .map((c) => (c in UA ? UA[c] : c))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
