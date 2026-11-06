import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir } from './data-dir.js';

interface Envelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

/**
 * Encrypts small secrets (provider API keys, GitHub tokens) at rest with
 * AES-256-GCM. The key lives next to the data with owner-only permissions.
 *
 * This protects against casual file reads and accidental commits. It is not a
 * substitute for an OS keychain; swapping in Electron safeStorage or the
 * Windows Credential Manager is a planned follow-up.
 */
export class SecretStore {
  private readonly key: Buffer;
  private records: Record<string, unknown>;

  constructor(
    private readonly file: string,
    keyFile: string,
  ) {
    ensureDir(dirname(file));
    this.key = SecretStore.loadKey(keyFile);
    this.records = this.load();
  }

  get<T>(name: string): T | undefined {
    return this.records[name] as T | undefined;
  }

  set(name: string, value: unknown): void {
    this.records[name] = value;
    this.persist();
  }

  remove(name: string): void {
    delete this.records[name];
    this.persist();
  }

  private static loadKey(keyFile: string): Buffer {
    if (existsSync(keyFile)) {
      const raw = readFileSync(keyFile);
      if (raw.length === 32) {
        return raw;
      }
    }
    const key = randomBytes(32);
    writeFileSync(keyFile, key, { mode: 0o600 });
    return key;
  }

  private load(): Record<string, unknown> {
    if (!existsSync(this.file)) {
      return {};
    }
    try {
      const envelope = JSON.parse(readFileSync(this.file, 'utf8')) as Envelope;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private persist(): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(this.records), 'utf8'),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    };
    writeFileSync(this.file, JSON.stringify(envelope), { mode: 0o600 });
  }
}
