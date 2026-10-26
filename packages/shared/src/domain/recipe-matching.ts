// FR-05. Нотатки vault: «Підбір рецептів», «Інгредієнт рецепта», «Сервіс підбору рецептів».
import { EXPIRING_BONUS_CAP, type Unit } from '../constants.js';
import type { FreshnessStatus } from './freshness.js';
import { normalizeName } from './normalize.js';

export interface IngredientRef {
  name: string;
  quantity: number;
  unit: Unit;
  optional?: boolean;
  /** Синоніми назви («томат» / «помідор»). */
  aliases?: string[];
}

export interface RecipeWithIngredients {
  id: string;
  title: string;
  cookingTimeMin: number;
  ingredients: IngredientRef[];
}

export interface ProductWithStatus {
  id: string;
  name: string;
  quantity: number;
  unit: Unit;
  status: FreshnessStatus;
}

export interface RecipeSuggestion {
  recipeId: string;
  /** Частка наявних обов'язкових інгредієнтів, 0…1. */
  coverage: number;
  /** Скільки наявних інгредієнтів зіставлено з продуктами зі статусом expiring (≤ EXPIRING_BONUS_CAP). */
  expiringUsed: number;
  missing: IngredientRef[];
  score: number;
}

/** Продукти, що відповідають інгредієнту: та сама нормалізована назва (або синонім), та сама одиниця, не прострочені. */
export function matchingProducts(ingredient: IngredientRef, products: ProductWithStatus[]): ProductWithStatus[] {
  const names = new Set([ingredient.name, ...(ingredient.aliases ?? [])].map(normalizeName));
  return products.filter((p) => names.has(normalizeName(p.name)) && p.unit === ingredient.unit && p.status !== 'expired');
}

/** Інгредієнт наявний, якщо сумарна кількість відповідних продуктів не менша за потрібну. */
export function isAvailable(ingredient: IngredientRef, products: ProductWithStatus[]): boolean {
  const total = matchingProducts(ingredient, products).reduce((s, p) => s + p.quantity, 0);
  return total >= ingredient.quantity;
}

/**
 * score = 100 × coverage + 10 × expiringUsed;
 * сортування: score ↓, cookingTimeMin ↑, title (uk) ↑; рецепти з coverage = 0 не повертаються.
 */
export function rankRecipes(recipes: RecipeWithIngredients[], products: ProductWithStatus[]): RecipeSuggestion[] {
  const titles = new Map(recipes.map((r) => [r.id, r]));
  const suggestions: RecipeSuggestion[] = [];
  for (const recipe of recipes) {
    const required = recipe.ingredients.filter((i) => !i.optional);
    if (required.length === 0) continue;
    const missing = required.filter((i) => !isAvailable(i, products));
    const coverage = (required.length - missing.length) / required.length;
    if (coverage === 0) continue;
    const expiring = recipe.ingredients.filter(
      (i) => isAvailable(i, products) && matchingProducts(i, products).some((p) => p.status === 'expiring'),
    ).length;
    const expiringUsed = Math.min(expiring, EXPIRING_BONUS_CAP);
    suggestions.push({ recipeId: recipe.id, coverage, expiringUsed, missing, score: 100 * coverage + 10 * expiringUsed });
  }
  return suggestions.sort((a, b) => {
    const ra = titles.get(a.recipeId)!;
    const rb = titles.get(b.recipeId)!;
    return b.score - a.score || ra.cookingTimeMin - rb.cookingTimeMin || ra.title.localeCompare(rb.title, 'uk');
  });
}
