import { describe, it, expect } from 'vitest';
import { EXPIRING_THRESHOLD_DAYS } from '../src/constants.js';
import { daysLeft, getFreshnessStatus } from '../src/domain/freshness.js';

const TODAY = '2026-10-26';

describe('daysLeft', () => {
  describe('Статус свіжості: daysLeft = expiresAt − today (календарні дні)', () => {
    it.each([
      ['2026-10-26', 0], // сьогодні
      ['2026-10-29', 3],
      ['2026-10-30', 4],
      ['2026-10-25', -1], // учора
      ['2026-10-16', -10],
    ] as const)('expiresAt=%s → %i', (expiresAt, expected) => {
      expect(daysLeft(expiresAt, TODAY)).toBe(expected);
    });

    it('перехід через межу місяця: 2026-10-31 → 2026-11-02 дає 2', () => {
      expect(daysLeft('2026-11-02', '2026-10-31')).toBe(2);
    });

    it('перехід через межу року: 2026-12-31 → 2027-01-01 дає 1', () => {
      expect(daysLeft('2027-01-01', '2026-12-31')).toBe(1);
    });

    it('високосний рік: 2028-02-28 → 2028-03-01 дає 2', () => {
      expect(daysLeft('2028-03-01', '2028-02-28')).toBe(2);
    });
  });

  describe('Термін придатності: дата без часу, формат YYYY-MM-DD', () => {
    it('некоректний формат expiresAt → RangeError', () => {
      expect(() => daysLeft('26.10.2026', TODAY)).toThrow(RangeError);
    });

    it('неіснуюча дата expiresAt → RangeError', () => {
      expect(() => daysLeft('2026-02-30', TODAY)).toThrow(RangeError);
    });

    it('некоректний формат today → RangeError', () => {
      expect(() => daysLeft('2026-10-26', '2026/10/26')).toThrow(RangeError);
    });
  });
});

describe('getFreshnessStatus', () => {
  describe('Статус свіжості: fresh, якщо expiresAt = null', () => {
    it('expiresAt = null → fresh', () => {
      expect(getFreshnessStatus(null, TODAY)).toBe('fresh');
    });
  });

  describe('Статус свіжості: expiring, якщо 0 ≤ daysLeft ≤ 3', () => {
    it('expiresAt = сьогодні → expiring', () => {
      expect(getFreshnessStatus('2026-10-26', TODAY)).toBe('expiring');
    });

    it('expiresAt = сьогодні + 3 → expiring', () => {
      expect(getFreshnessStatus('2026-10-29', TODAY)).toBe('expiring');
    });

    it.each([
      ['2026-10-27', 'expiring'], // +1
      ['2026-10-28', 'expiring'], // +2
    ] as const)('expiresAt=%s → %s', (expiresAt, expected) => {
      expect(getFreshnessStatus(expiresAt, TODAY)).toBe(expected);
    });
  });

  describe('Статус свіжості: fresh, якщо daysLeft > 3', () => {
    it('expiresAt = сьогодні + 4 → fresh', () => {
      expect(getFreshnessStatus('2026-10-30', TODAY)).toBe('fresh');
    });

    it('expiresAt далеко в майбутньому → fresh', () => {
      expect(getFreshnessStatus('2027-10-26', TODAY)).toBe('fresh');
    });
  });

  describe('Статус свіжості: expired, якщо daysLeft < 0', () => {
    it('expiresAt = учора → expired', () => {
      expect(getFreshnessStatus('2026-10-25', TODAY)).toBe('expired');
    });

    it('expiresAt давно в минулому → expired', () => {
      expect(getFreshnessStatus('2025-01-01', TODAY)).toBe('expired');
    });
  });

  describe('Статус свіжості: поріг — константа EXPIRING_THRESHOLD_DAYS = 3', () => {
    it('значення за замовчуванням дорівнює 3', () => {
      expect(EXPIRING_THRESHOLD_DAYS).toBe(3);
    });

    it('без третього аргументу використовується EXPIRING_THRESHOLD_DAYS', () => {
      expect(getFreshnessStatus('2026-10-29', TODAY)).toBe(
        getFreshnessStatus('2026-10-29', TODAY, EXPIRING_THRESHOLD_DAYS),
      );
    });
  });

  describe('Сервіс статусів свіжості: параметр thresholdDays', () => {
    it.each([
      [0, '2026-10-26', 'expiring'], // поріг 0: лише сьогодні
      [0, '2026-10-27', 'fresh'],
      [0, '2026-10-25', 'expired'],
      [7, '2026-11-02', 'expiring'], // +7 — межа
      [7, '2026-11-03', 'fresh'], // +8
    ] as const)('thresholdDays=%i, expiresAt=%s → %s', (threshold, expiresAt, expected) => {
      expect(getFreshnessStatus(expiresAt, TODAY, threshold)).toBe(expected);
    });

    it('expiresAt = null із будь-яким порогом → fresh', () => {
      expect(getFreshnessStatus(null, TODAY, 0)).toBe('fresh');
    });
  });

  describe('ADR-0003: поточна дата — параметр, функція детермінована', () => {
    it('той самий expiresAt з різним today дає різні статуси', () => {
      const expiresAt = '2026-10-29';
      expect(getFreshnessStatus(expiresAt, '2026-10-20')).toBe('fresh');
      expect(getFreshnessStatus(expiresAt, '2026-10-26')).toBe('expiring');
      expect(getFreshnessStatus(expiresAt, '2026-10-30')).toBe('expired');
    });

    it('повторний виклик з тими самими аргументами → той самий результат', () => {
      expect(getFreshnessStatus('2026-10-27', TODAY)).toBe(getFreshnessStatus('2026-10-27', TODAY));
    });
  });

  describe('Валідація входів', () => {
    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY] as const)(
      'thresholdDays=%s → RangeError',
      (threshold) => {
        expect(() => getFreshnessStatus('2026-10-26', TODAY, threshold)).toThrow(RangeError);
      },
    );

    it('некоректний thresholdDays кидає виняток і для expiresAt = null', () => {
      expect(() => getFreshnessStatus(null, TODAY, -1)).toThrow(RangeError);
    });

    it('некоректний формат expiresAt → RangeError', () => {
      expect(() => getFreshnessStatus('завтра', TODAY)).toThrow(RangeError);
    });

    it('неіснуюча дата today → RangeError', () => {
      expect(() => getFreshnessStatus('2026-10-26', '2026-13-01')).toThrow(RangeError);
    });
  });
});
