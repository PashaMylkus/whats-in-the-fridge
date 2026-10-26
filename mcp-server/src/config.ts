import path from 'node:path';
import { existsSync } from 'node:fs';

export interface Config {
  /** Абсолютний шлях до локального клону репозиторію vault. */
  vaultPath: string;
  /** Абсолютний шлях до репозиторію застосунку (для поля source). */
  appPath: string;
  /** Назва репозиторію застосунку у полі source. */
  appRepoName: string;
  /** Виконувати git pull --ff-only перед записом. */
  gitPull: boolean;
  /** Виконувати git push після коміту. */
  gitPush: boolean;
}

const flag = (v: string | undefined, def: boolean) =>
  v === undefined || v === '' ? def : !['0', 'false', 'no', 'off'].includes(v.toLowerCase());

export function loadConfig(env = process.env): Config {
  const raw = env.VAULT_PATH;
  if (!raw) throw new Error('VAULT_PATH не задано: вкажіть шлях до клону репозиторію vault');
  const vaultPath = path.resolve(raw);
  if (!existsSync(path.join(vaultPath, '.git'))) {
    throw new Error(`VAULT_PATH=${vaultPath} не є git-репозиторієм`);
  }
  const appPath = path.resolve(env.APP_PATH || process.cwd());
  return {
    vaultPath,
    appPath,
    appRepoName: env.APP_REPO_NAME || path.basename(appPath),
    gitPull: flag(env.KB_GIT_PULL, true),
    gitPush: flag(env.KB_GIT_PUSH, true),
  };
}
