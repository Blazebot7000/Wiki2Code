import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureDir } from './data-dir.js';

/**
 * Small JSON document store with atomic writes. One process should own each
 * file; every service in this app owns exactly one store.
 */
export class JsonStore<T extends object> {
  private cache: T | null = null;

  constructor(
    private readonly file: string,
    private readonly defaults: T,
  ) {
    ensureDir(dirname(file));
  }

  read(): T {
    if (this.cache) {
      return this.cache;
    }
    if (!existsSync(this.file)) {
      this.cache = structuredClone(this.defaults);
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as T;
      this.cache = { ...structuredClone(this.defaults), ...parsed };
    } catch {
      this.cache = structuredClone(this.defaults);
    }
    return this.cache;
  }

  write(value: T): T {
    this.cache = value;
    const tmp = join(
      dirname(this.file),
      `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, this.file);
    return value;
  }

  update(mutator: (current: T) => T): T {
    return this.write(mutator(this.read()));
  }
}
