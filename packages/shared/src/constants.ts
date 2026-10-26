/** Поріг «скоро зіпсується», днів (нотатка vault «Статус свіжості»). */
export const EXPIRING_THRESHOLD_DAYS = 3;

/** Максимум продуктів зі статусом expiring, що підвищують рейтинг рецепта («Підбір рецептів»). */
export const EXPIRING_BONUS_CAP = 3;

export const STORAGE_LOCATIONS = ['fridge', 'freezer', 'pantry'] as const;
export type StorageLocation = (typeof STORAGE_LOCATIONS)[number];

export const PRODUCT_CATEGORIES = [
  'dairy', 'meat', 'vegetables', 'fruits', 'grains', 'bakery', 'drinks', 'sauces', 'frozen', 'other',
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const UNITS = ['pcs', 'g', 'kg', 'ml', 'l'] as const;
export type Unit = (typeof UNITS)[number];
