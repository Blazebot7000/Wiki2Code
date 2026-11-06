import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIR_NAME = 'Wiki2Code';

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveDataDir(): string {
  const configured = process.env.WIKI2CODE_DATA_DIR?.trim();
  const fallbackBase = process.env.APPDATA ?? join(homedir(), '.config');
  const base =
    configured && configured.length > 0
      ? configured
      : join(fallbackBase, APP_DIR_NAME);
  return ensureDir(base);
}

export function dataPath(...parts: string[]): string {
  return join(resolveDataDir(), ...parts);
}

export function repoPath(repoId: string, kind: 'code' | 'wiki'): string {
  return ensureDir(dataPath('repos', repoId, kind));
}

export function safeRepoId(owner: string, name: string): string {
  return `${owner}__${name}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
}
