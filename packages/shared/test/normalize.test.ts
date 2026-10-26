import { describe, it, expect } from 'vitest';
import { isSameName, normalizeName } from '../src/domain/normalize.js';

describe('normalizeName', () => {
  describe('Сервіс нормалізації назв, правило 1: Unicode NFC', () => {
    it('літера з комбінованим знаком → та сама, що й готова літера', () => {
      const decomposed = 'ї'.normalize('NFD'); // і + U+0308
      expect(decomposed).not.toBe('ї');
      expect(normalizeName(`${decomposed}жак`)).toBe('їжак');
    });
  });

  describe('Сервіс нормалізації назв, правило 2: нижній регістр (uk)', () => {
    it.each([
      ['МОЛОКО', 'молоко'],
      ['Гречка', 'гречка'],
      ['ЄЖАК Їжак', 'єжак їжак'],
    ] as const)('%s → %s', (input, expected) => {
      expect(normalizeName(input)).toBe(expected);
    });

    it('цифри й символи всередині зберігаються: «МОЛОКО 2,5%» → «молоко 2,5%»', () => {
      expect(normalizeName('МОЛОКО 2,5%')).toBe('молоко 2,5%');
    });
  });

  describe('Сервіс нормалізації назв, правило 3: варіанти апострофа → \'', () => {
    it.each([
      ['м’ясо', 'U+2019'],
      ['мʼясо', 'U+02BC'],
      ['м`ясо', 'backtick'],
      ['м´ясо', 'U+00B4'],
      ['м‘ясо', 'U+2018'],
      ["м'ясо", 'ASCII'],
    ] as const)('%s (%s) → м\'ясо', (input) => {
      expect(normalizeName(input)).toBe("м'ясо");
    });
  });

  describe('Сервіс нормалізації назв, правило 4: пробільні символи → один пробіл', () => {
    it('таб і перенос рядка: «Сир\\tтвердий\\n» → «сир твердий»', () => {
      expect(normalizeName('Сир\tтвердий\n')).toBe('сир твердий');
    });

    it('кілька пробілів усередині → один', () => {
      expect(normalizeName('рис    басматі')).toBe('рис басматі');
    });

    it('змішана послідовність пробільних символів → один пробіл', () => {
      expect(normalizeName('сир \t\n твердий')).toBe('сир твердий');
    });
  });

  describe('Сервіс нормалізації назв, правило 5: пунктуація й пробіли на краях', () => {
    it('«  Молоко  » → «молоко»', () => {
      expect(normalizeName('  Молоко  ')).toBe('молоко');
    });

    it('«Гречка» у лапках-ялинках → «гречка»', () => {
      expect(normalizeName('«Гречка»')).toBe('гречка');
    });

    it('«яйця!!!» → «яйця»', () => {
      expect(normalizeName('яйця!!!')).toBe('яйця');
    });

    it.each([
      ['.молоко', 'молоко'],
      [',молоко;', 'молоко'],
      [':молоко?', 'молоко'],
      ['"молоко"', 'молоко'],
      ['-молоко-', 'молоко'],
    ] as const)('%s → %s', (input, expected) => {
      expect(normalizeName(input)).toBe(expected);
    });

    it('розділові знаки всередині назви зберігаються: «сир, твердий» і «кисло-солодкий»', () => {
      expect(normalizeName('сир, твердий')).toBe('сир, твердий');
      expect(normalizeName('кисло-солодкий соус')).toBe('кисло-солодкий соус');
    });

    it('дужки не прибираються всередині: «Рис басматі (довгий) 1 кг»', () => {
      expect(normalizeName('Рис басматі (довгий) 1 кг')).toBe('рис басматі (довгий) 1 кг');
    });

    it('дужки не прибираються, коли уточнення в кінці: «Рис (довгий)» → «рис (довгий)»', () => {
      expect(normalizeName('Рис (довгий)')).toBe('рис (довгий)');
    });

    it('«рис басматі (довгий)» → «рис басматі (довгий)»', () => {
      expect(normalizeName('рис басматі (довгий)')).toBe('рис басматі (довгий)');
    });
  });

  describe('Сервіс нормалізації назв, граничні випадки', () => {
    it('порожній рядок → порожній рядок', () => {
      expect(normalizeName('')).toBe('');
    });

    it('« ... » → порожній рядок', () => {
      expect(normalizeName(' ... ')).toBe('');
    });

    it('лише пробіли → порожній рядок', () => {
      expect(normalizeName('   ')).toBe('');
    });

    it('ідемпотентність: повторна нормалізація не змінює результат', () => {
      const once = normalizeName('  «М’ЯСО   свиняче»! ');
      expect(normalizeName(once)).toBe(once);
    });
  });

  describe('Сервіс нормалізації назв: синоніми не обробляються', () => {
    it('«Томат» і «Помідор» лишаються різними назвами', () => {
      expect(normalizeName('Томат')).toBe('томат');
      expect(normalizeName('Помідор')).toBe('помідор');
    });
  });
});

describe('isSameName', () => {
  describe('Сервіс нормалізації назв, контракт: normalizeName(a) === normalizeName(b)', () => {
    it('isSameName(«М’ЯСО», «мʼясо») → true', () => {
      expect(isSameName('М’ЯСО', 'мʼясо')).toBe(true);
    });

    it('isSameName(«томат», «помідор») → false', () => {
      expect(isSameName('томат', 'помідор')).toBe(false);
    });

    it('відмінність лише в регістрі, пробілах і пунктуації на краях → true', () => {
      expect(isSameName('  Молоко ', 'молоко!')).toBe(true);
    });

    it('різні назви → false', () => {
      expect(isSameName('молоко', 'молоко 2,5%')).toBe(false);
    });

    it('дві порожні після нормалізації назви → true', () => {
      expect(isSameName('', ' ... ')).toBe(true);
    });
  });
});
