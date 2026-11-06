import { dataPath, JsonStore } from '@org/server';

export interface WatcherState {
  repoId: string;
  enabled: boolean;
  intervalMs: number;
  lastCheckedAt?: string;
  lastCodeSha?: string;
  lastWikiSha?: string;
  pendingReview: boolean;
  lastError?: string;
}

export interface SyncStoreState {
  watchers: Record<string, WatcherState>;
}

export const syncStore = new JsonStore<SyncStoreState>(
  dataPath('sync-svc.json'),
  { watchers: {} },
);
