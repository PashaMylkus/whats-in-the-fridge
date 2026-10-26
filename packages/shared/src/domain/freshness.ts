// FR-03. Нотатки vault: «Статус свіжості», «Термін придатності», «Сервіс статусів свіжості».
// Чиста функція: поточна дата передається параметром (ADR-0003).
import { EXPIRING_THRESHOLD_DAYS } from '../constants.js';
import { diffDays } from './dates.js';

export type FreshnessStatus = 'fresh' | 'expiring' | 'expired';

/** Скільки днів лишилося до кінця терміну: expiresAt − today. */
export function daysLeft(expiresAt: string, today: string): number {
  return diffDays(today, expiresAt);
}

/**
 * fresh    — термін не задано або daysLeft > threshold;
 * expiring — 0 ≤ daysLeft ≤ threshold;
 * expired  — daysLeft < 0.
 */
export function getFreshnessStatus(
  expiresAt: string | null,
  today: string,
  thresholdDays: number = EXPIRING_THRESHOLD_DAYS,
): FreshnessStatus {
  if (!Number.isInteger(thresholdDays) || thresholdDays < 0) {
    throw new RangeError(`thresholdDays має бути цілим числом ≥ 0, отримано ${thresholdDays}`);
  }
  if (expiresAt === null) return 'fresh';
  const left = daysLeft(expiresAt, today);
  if (left < 0) return 'expired';
  if (left <= thresholdDays) return 'expiring';
  return 'fresh';
}
