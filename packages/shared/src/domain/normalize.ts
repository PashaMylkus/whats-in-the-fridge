// Нормалізація назв продуктів та інгредієнтів для зіставлення (нотатки «Продукт», «Інгредієнт рецепта»).

const APOSTROPHES = /[’ʼ`´‘]/g;
const EDGE_PUNCTUATION = /^[\s.,;:!?«»"()-]+|[\s.,;:!?«»"()-]+$/g;

/** Нижній регістр, єдиний апостроф, без зайвих пробілів і розділових знаків на краях. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFC')
    .toLocaleLowerCase('uk')
    .replace(APOSTROPHES, "'")
    .replace(/\s+/g, ' ')
    .replace(EDGE_PUNCTUATION, '');
}

/** Чи позначають дві назви той самий продукт. */
export function isSameName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}
