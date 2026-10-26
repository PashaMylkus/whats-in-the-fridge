import { describe, it, expect } from 'vitest';
import { EXPIRING_BONUS_CAP, type Unit } from '../src/constants.js';
import type { FreshnessStatus } from '../src/domain/freshness.js';
import {
  isAvailable,
  matchingProducts,
  rankRecipes,
  type IngredientRef,
  type ProductWithStatus,
  type RecipeWithIngredients,
} from '../src/domain/recipe-matching.js';

// Фабрики фікстур: значення за замовчуванням — свіжий продукт у штуках / інгредієнт 1 шт.
let seq = 0;
const product = (
  name: string,
  quantity: number,
  unit: Unit = 'pcs',
  status: FreshnessStatus = 'fresh',
): ProductWithStatus => ({ id: `p${++seq}`, name, quantity, unit, status });

const ing = (name: string, quantity = 1, unit: Unit = 'pcs', extra: Partial<IngredientRef> = {}): IngredientRef => ({
  name,
  quantity,
  unit,
  ...extra,
});

const recipe = (
  id: string,
  ingredients: IngredientRef[],
  cookingTimeMin = 30,
  title = id,
): RecipeWithIngredients => ({ id, title, cookingTimeMin, ingredients });

const ids = (list: { recipeId: string }[]) => list.map((s) => s.recipeId);

describe('matchingProducts', () => {
  describe('Інгредієнт рецепта: та сама нормалізована назва', () => {
    it('різний регістр і зайві пробіли → продукт зіставлено', () => {
      const milk = product('  МОЛОКО ', 1, 'l');
      expect(matchingProducts(ing('молоко', 1, 'l'), [milk])).toEqual([milk]);
    });

    it('різні апострофи (’ і ʼ) → продукт зіставлено', () => {
      const p = product('м’ясо', 500, 'g');
      expect(matchingProducts(ing('мʼясо', 500, 'g'), [p])).toEqual([p]);
    });

    it('інша назва → порожній результат', () => {
      expect(matchingProducts(ing('молоко', 1, 'l'), [product('кефір', 1, 'l')])).toEqual([]);
    });
  });

  describe('Інгредієнт рецепта: синоніми через aliases', () => {
    it('назва продукту збігається з синонімом інгредієнта → зіставлено', () => {
      const tomato = product('Помідор', 2);
      expect(matchingProducts(ing('томат', 1, 'pcs', { aliases: ['помідор'] }), [tomato])).toEqual([tomato]);
    });

    it('без aliases синонім не зіставляється', () => {
      expect(matchingProducts(ing('томат'), [product('помідор', 2)])).toEqual([]);
    });
  });

  describe('Інгредієнт рецепта: та сама одиниця виміру', () => {
    it('та сама назва, але g проти kg → не зіставлено (конвертації немає)', () => {
      expect(matchingProducts(ing('борошно', 500, 'g'), [product('борошно', 1, 'kg')])).toEqual([]);
    });
  });

  describe('Інгредієнт рецепта: статус, відмінний від expired', () => {
    it.each([
      ['fresh', 1],
      ['expiring', 1],
      ['expired', 0],
    ] as const)('статус %s → знайдено %i', (status, expectedCount) => {
      const result = matchingProducts(ing('сир'), [product('сир', 1, 'pcs', status)]);
      expect(result).toHaveLength(expectedCount);
    });
  });

  it('кілька відповідних продуктів → усі повертаються в початковому порядку', () => {
    const a = product('яйця', 3);
    const b = product('яйця', 5, 'pcs', 'expiring');
    expect(matchingProducts(ing('яйця'), [a, product('сіль', 1), b])).toEqual([a, b]);
  });
});

describe('isAvailable', () => {
  describe('Інгредієнт рецепта: кількість ≥ потрібної', () => {
    it.each([
      [200, 300, false], // менше
      [300, 300, true], // межа: рівно
      [301, 300, true], // більше
    ] as const)('є %i, потрібно %i → %s', (have, need, expected) => {
      expect(isAvailable(ing('борошно', need, 'g'), [product('борошно', have, 'g')])).toBe(expected);
    });
  });

  it('продуктів немає → false', () => {
    expect(isAvailable(ing('борошно', 100, 'g'), [])).toBe(false);
  });

  it('єдиний продукт прострочений → false, навіть якщо кількості достатньо', () => {
    expect(isAvailable(ing('молоко', 1, 'l'), [product('молоко', 2, 'l', 'expired')])).toBe(false);
  });

  it('прострочений продукт не додається до кількості свіжого', () => {
    const products = [product('молоко', 1, 'l'), product('молоко', 1, 'l', 'expired')];
    expect(isAvailable(ing('молоко', 2, 'l'), products)).toBe(false);
  });

  // Нотатка «Інгредієнт рецепта»: сумарна кількість відповідних продуктів.
  it('два продукти по 100 г, потрібно 150 г → true (кількості сумуються)', () => {
    const products = [product('борошно', 100, 'g'), product('борошно', 100, 'g')];
    expect(isAvailable(ing('борошно', 150, 'g'), products)).toBe(true);
  });

  it('два продукти по 100 г, потрібно 250 г → false (сума менша)', () => {
    const products = [product('борошно', 100, 'g'), product('борошно', 100, 'g')];
    expect(isAvailable(ing('борошно', 250, 'g'), products)).toBe(false);
  });
});

describe('rankRecipes', () => {
  describe('Підбір рецептів: coverage = наявні обов\'язкові / усі обов\'язкові', () => {
    it.each([
      [['яйця', 'молоко', 'борошно'], 1], // усі
      [['яйця', 'молоко'], 2 / 3],
      [['яйця'], 1 / 3],
    ] as const)('є %j → coverage %d', (have, expected) => {
      const r = recipe('r', [ing('яйця'), ing('молоко'), ing('борошно')]);
      const [s] = rankRecipes([r], have.map((n) => product(n, 1)));
      expect(s?.coverage).toBeCloseTo(expected, 10);
    });

    it('необов\'язковий інгредієнт не впливає на coverage', () => {
      const r = recipe('r', [ing('яйця'), ing('зелень', 1, 'pcs', { optional: true })]);
      expect(rankRecipes([r], [product('яйця', 1)])[0]?.coverage).toBe(1);
    });

    it('необов\'язковий інгредієнт наявний, а обов\'язковий ні → рецепт не повертається', () => {
      const r = recipe('r', [ing('яйця'), ing('зелень', 1, 'pcs', { optional: true })]);
      expect(rankRecipes([r], [product('зелень', 1)])).toEqual([]);
    });
  });

  describe('Підбір рецептів: рецепти з coverage = 0 не повертаються', () => {
    it('жодного наявного інгредієнта → порожній результат', () => {
      expect(rankRecipes([recipe('r', [ing('яйця')])], [product('сіль', 1)])).toEqual([]);
    });

    it('порожній каталог → порожній результат', () => {
      expect(rankRecipes([], [product('яйця', 1)])).toEqual([]);
    });

    it('продуктів немає → порожній результат', () => {
      expect(rankRecipes([recipe('r', [ing('яйця')])], [])).toEqual([]);
    });

    it('єдиний збіг — прострочений продукт → порожній результат', () => {
      expect(rankRecipes([recipe('r', [ing('яйця')])], [product('яйця', 1, 'pcs', 'expired')])).toEqual([]);
    });

    it('рецепт без обов\'язкових інгредієнтів (порожній або лише optional) → не повертається', () => {
      const onlyOptional = recipe('opt', [ing('зелень', 1, 'pcs', { optional: true })]);
      expect(rankRecipes([recipe('empty', []), onlyOptional], [product('зелень', 1)])).toEqual([]);
    });
  });

  describe('Підбір рецептів: відповідь містить список відсутніх інгредієнтів', () => {
    it('missing містить лише ненаявні обов\'язкові інгредієнти', () => {
      const milk = ing('молоко', 1, 'l');
      const flour = ing('борошно', 500, 'g');
      const r = recipe('r', [ing('яйця'), milk, flour, ing('зелень', 1, 'pcs', { optional: true })]);
      const [s] = rankRecipes([r], [product('яйця', 1), product('борошно', 100, 'g')]);
      expect(s?.missing).toEqual([milk, flour]);
    });

    it('усе наявне → missing порожній', () => {
      const [s] = rankRecipes([recipe('r', [ing('яйця')])], [product('яйця', 1)]);
      expect(s?.missing).toEqual([]);
    });
  });

  describe('Підбір рецептів: score = 100 × coverage + 10 × expiringUsed', () => {
    it('усе свіже, coverage 1 → score 100, expiringUsed 0', () => {
      const [s] = rankRecipes([recipe('r', [ing('яйця'), ing('молоко', 1, 'l')])], [product('яйця', 1), product('молоко', 1, 'l')]);
      expect(s).toEqual({ recipeId: 'r', coverage: 1, expiringUsed: 0, missing: [], score: 100 });
    });

    it('coverage 1/2 і один expiring → score 60', () => {
      const [s] = rankRecipes(
        [recipe('r', [ing('яйця'), ing('молоко', 1, 'l')])],
        [product('яйця', 1, 'pcs', 'expiring')],
      );
      expect(s?.coverage).toBe(0.5);
      expect(s?.expiringUsed).toBe(1);
      expect(s?.score).toBe(60);
    });
  });

  describe('Підбір рецептів: expiringUsed — наявні інгредієнти з продуктами expiring', () => {
    it('два наявні інгредієнти з expiring → expiringUsed 2, score 120', () => {
      const r = recipe('r', [ing('яйця'), ing('сир'), ing('хліб')]);
      const [s] = rankRecipes([r], [
        product('яйця', 1, 'pcs', 'expiring'),
        product('сир', 1, 'pcs', 'expiring'),
        product('хліб', 1),
      ]);
      expect(s).toMatchObject({ coverage: 1, expiringUsed: 2, score: 120 });
    });

    it('expiring-продукт є, але кількості недостатньо → не рахується', () => {
      const r = recipe('r', [ing('яйця'), ing('молоко', 2, 'l')]);
      const [s] = rankRecipes([r], [product('яйця', 1), product('молоко', 1, 'l', 'expiring')]);
      expect(s?.expiringUsed).toBe(0);
    });

    it('два expiring-продукти на один інгредієнт → рахується як 1 інгредієнт', () => {
      const r = recipe('r', [ing('яйця', 2)]);
      const [s] = rankRecipes([r], [product('яйця', 1, 'pcs', 'expiring'), product('яйця', 1, 'pcs', 'expiring')]);
      expect(s?.expiringUsed).toBe(1);
    });

    it.each([
      [2, 2],
      [3, 3], // межа
      [4, 3], // понад обмеження
      [5, 3],
    ] as const)('%i наявних expiring-інгредієнтів → expiringUsed %i (обмеження 3)', (count, expected) => {
      const names = Array.from({ length: count }, (_, i) => `продукт${i}`);
      const r = recipe('r', names.map((n) => ing(n)));
      const [s] = rankRecipes([r], names.map((n) => product(n, 1, 'pcs', 'expiring')));
      expect(s?.expiringUsed).toBe(expected);
      expect(s?.score).toBe(100 + 10 * expected);
    });

    it('обмеження дорівнює EXPIRING_BONUS_CAP = 3', () => {
      expect(EXPIRING_BONUS_CAP).toBe(3);
    });
  });

  describe('Підбір рецептів: сортування score ↓, cookingTimeMin ↑, title ↑', () => {
    const eggs = [product('яйця', 1)];

    it('вищий score йде першим, незалежно від порядку вводу', () => {
      const full = recipe('full', [ing('яйця')], 60);
      const half = recipe('half', [ing('яйця'), ing('сіль')], 5);
      expect(ids(rankRecipes([half, full], eggs))).toEqual(['full', 'half']);
    });

    it('expiring-бонус піднімає рецепт над рецептом із тим самим coverage', () => {
      // a: coverage 1, без бонусу → 100; c: coverage 1 + 1 expiring → 110
      const a = recipe('a', [ing('яйця')]);
      const c = recipe('c', [ing('сир')]);
      const products = [product('яйця', 1), product('сир', 1, 'pcs', 'expiring')];
      expect(ids(rankRecipes([a, c], products))).toEqual(['c', 'a']);
    });

    it('однаковий score → коротший час приготування першим', () => {
      const slow = recipe('slow', [ing('яйця')], 45);
      const fast = recipe('fast', [ing('яйця')], 10);
      expect(ids(rankRecipes([slow, fast], eggs))).toEqual(['fast', 'slow']);
    });

    it('однаковий score і час → за назвою (українська колація)', () => {
      const v = recipe('v', [ing('яйця')], 20, 'Вареники');
      const b = recipe('b', [ing('яйця')], 20, 'Борщ');
      const h = recipe('h', [ing('яйця')], 20, 'Гречка');
      expect(ids(rankRecipes([h, v, b], eggs))).toEqual(['b', 'v', 'h']);
    });

    it('українська колація: «і» після «и», «ї» після «і»', () => {
      const t = (id: string, title: string) => recipe(id, [ing('яйця')], 20, title);
      const result = rankRecipes([t('yi', 'Їжак'), t('i', 'Ікра'), t('y', 'Икра')], eggs);
      expect(ids(result)).toEqual(['y', 'i', 'yi']);
    });

    it('повний порядок: score, потім час, потім назва; числові поля збережено', () => {
      const products = [product('яйця', 1), product('сир', 1, 'pcs', 'expiring'), product('хліб', 1)];
      const recipes = [
        recipe('r-half', [ing('яйця'), ing('сіль')], 5, 'Омлет'), // 50
        recipe('r-b', [ing('яйця')], 20, 'Бутерброд'), // 100
        recipe('r-a', [ing('хліб')], 20, 'Анчоус'), // 100, раніше за назвою
        recipe('r-slow', [ing('яйця')], 40, 'Австрійське'), // 100, повільніший
        recipe('r-cheese', [ing('сир')], 50, 'Сирник'), // 110
      ];
      expect(rankRecipes(recipes, products)).toEqual([
        { recipeId: 'r-cheese', coverage: 1, expiringUsed: 1, missing: [], score: 110 },
        { recipeId: 'r-a', coverage: 1, expiringUsed: 0, missing: [], score: 100 },
        { recipeId: 'r-b', coverage: 1, expiringUsed: 0, missing: [], score: 100 },
        { recipeId: 'r-slow', coverage: 1, expiringUsed: 0, missing: [], score: 100 },
        { recipeId: 'r-half', coverage: 0.5, expiringUsed: 0, missing: [ing('сіль')], score: 50 },
      ]);
    });
  });

  describe('ADR-0003: чиста функція', () => {
    it('вхідні масиви не змінюються, повторний виклик дає той самий результат', () => {
      const recipes = [recipe('b', [ing('яйця')], 20), recipe('a', [ing('яйця'), ing('сіль')], 10)];
      const products = [product('яйця', 1)];
      const recipesBefore = structuredClone(recipes);
      const productsBefore = structuredClone(products);

      const first = rankRecipes(recipes, products);
      const second = rankRecipes(recipes, products);

      expect(second).toEqual(first);
      expect(recipes).toEqual(recipesBefore);
      expect(products).toEqual(productsBefore);
    });
  });
});
