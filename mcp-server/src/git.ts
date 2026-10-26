import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export async function hasRemote(cwd: string): Promise<boolean> {
  return (await git(cwd, 'remote')).split('\n').some(Boolean);
}

export async function headShort(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, 'rev-parse', '--short=7', 'HEAD');
  } catch {
    return null;
  }
}

/** Оновлює клон vault перед записом. Лише fast-forward: розбіжна історія — помилка, а не автоматичне злиття. */
export async function pullFastForward(cwd: string): Promise<'pulled' | 'no-remote'> {
  if (!(await hasRemote(cwd))) return 'no-remote';
  await git(cwd, 'pull', '--ff-only', '--quiet');
  return 'pulled';
}

export async function commitFiles(cwd: string, files: string[], message: string): Promise<string | null> {
  await git(cwd, 'add', '--', ...files);
  const staged = await git(cwd, 'diff', '--cached', '--name-only');
  if (!staged) return null;
  await git(cwd, 'commit', '--quiet', '-m', message);
  return headShort(cwd);
}

export async function push(cwd: string): Promise<{ pushed: boolean; error?: string }> {
  if (!(await hasRemote(cwd))) return { pushed: false, error: 'немає віддаленого репозиторію' };
  try {
    await git(cwd, 'push', '--quiet', 'origin', 'HEAD');
    return { pushed: true };
  } catch (e) {
    return { pushed: false, error: (e as Error).message.split('\n')[0] };
  }
}
