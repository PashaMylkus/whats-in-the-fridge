// Календарні дати як рядки YYYY-MM-DD без часу: порівняння за днями,
// без залежності від часового поясу сервера (нотатка «Термін придатності»).

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Перетворює YYYY-MM-DD на номер дня від епохи (UTC). Кидає RangeError для некоректної дати. */
export function toDayNumber(date: string): number {
  const m = ISO_DATE.exec(date);
  if (!m) throw new RangeError(`Очікується дата у форматі YYYY-MM-DD, отримано "${date}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`Неіснуюча дата "${date}"`);
  }
  return ms / DAY_MS;
}

/** Кількість календарних днів від `from` до `to` (від'ємна, якщо `to` раніше). */
export function diffDays(from: string, to: string): number {
  return toDayNumber(to) - toDayNumber(from);
}
