import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_PORTS,
  GITHUB_PATTERNS,
  REVIEW_PATTERNS,
  type ConnectedRepo,
  type SyncState,
} from '@org/contracts';
import { createTcpClient, sendTo } from '@org/server';
import { syncStore, type WatcherState } from './sync.store';

interface PollResult {
  codeChanged: boolean;
  wikiChanged: boolean;
  codeSha?: string;
  wikiSha?: string;
  changedPaths: string[];
}

const DEFAULT_INTERVAL = 60_000;

/**
 * Sync is manual: nothing polls repositories on a timer. The Sync button calls
 * `tick` once, which detects changes and marks affected highlights stale, then
 * refreshes the local clones. Syncing never starts an AI review; reviews only
 * run when the user presses the AI review button.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly busy = new Set<string>();
  private readonly github = createTcpClient(
    Number(process.env.GITHUB_SVC_PORT ?? DEFAULT_PORTS.github),
  );
  private readonly reviews = createTcpClient(
    Number(process.env.REVIEW_SVC_PORT ?? DEFAULT_PORTS.review),
  );

  start(payload: {
    repoId: string;
    intervalMs?: number;
    immediate?: boolean;
  }): SyncState {
    const existing = syncStore.read().watchers[payload.repoId];
    const watcher: WatcherState = {
      ...(existing ?? { pendingReview: false }),
      repoId: payload.repoId,
      enabled: true,
      intervalMs: Number(payload.intervalMs) || DEFAULT_INTERVAL,
    };
    this.persist(watcher);
    return this.toState(watcher);
  }

  stop(payload: { repoId: string }): SyncState {
    const existing = syncStore.read().watchers[payload.repoId];
    const watcher: WatcherState = {
      ...(existing ?? { pendingReview: false }),
      repoId: payload.repoId,
      enabled: false,
      intervalMs: existing?.intervalMs ?? DEFAULT_INTERVAL,
    };
    this.persist(watcher);
    return this.toState(watcher);
  }

  async list(): Promise<SyncState[]> {
    const repos = await sendTo<ConnectedRepo[]>(
      this.github,
      GITHUB_PATTERNS.REPO_LIST,
      {},
    );
    const watchers = syncStore.read().watchers;
    return repos.map((repo) =>
      this.toState(
        watchers[repo.repoId] ?? {
          repoId: repo.repoId,
          enabled: false,
          intervalMs: DEFAULT_INTERVAL,
          pendingReview: false,
          lastCodeSha: repo.lastCodeSha,
          lastWikiSha: repo.lastWikiSha,
        },
      ),
    );
  }

  state(payload: { repoId: string }): SyncState {
    const existing = syncStore.read().watchers[payload.repoId];
    return this.toState(
      existing ?? {
        repoId: payload.repoId,
        enabled: false,
        intervalMs: DEFAULT_INTERVAL,
        pendingReview: false,
      },
    );
  }

  async tick(payload: { repoId: string }): Promise<SyncState> {
    const repoId = payload.repoId;
    if (this.busy.has(repoId)) {
      return this.state({ repoId });
    }
    this.busy.add(repoId);

    try {
      const poll = await sendTo<PollResult>(
        this.github,
        GITHUB_PATTERNS.REPO_POLL,
        { repoId },
      );

      if (poll.codeChanged && poll.changedPaths.length > 0) {
        const stale = await sendTo<{ changed: number }>(
          this.reviews,
          REVIEW_PATTERNS.HIGHLIGHTS_MARK_STALE,
          {
            repoId,
            paths: poll.changedPaths,
            commitSha: poll.codeSha ?? '',
          },
        );
        this.logger.log(
          `Code changed in ${repoId}; marked ${stale.changed} highlight(s) stale`,
        );
      }

      const existing = syncStore.read().watchers[repoId];
      const watcher: WatcherState = {
        ...(existing ?? { repoId, enabled: false, intervalMs: DEFAULT_INTERVAL }),
        repoId,
        lastCheckedAt: new Date().toISOString(),
        lastCodeSha: poll.codeSha ?? existing?.lastCodeSha,
        lastWikiSha: poll.wikiSha ?? existing?.lastWikiSha,
        // Reviews are never started by a sync. The next review is always an
        // explicit AI button press, so there is nothing to retry here.
        pendingReview: false,
        pendingPaths: undefined,
        lastError: undefined,
      };
      this.persist(watcher);
      return this.toState(watcher);
    } catch (error) {
      const message = this.describe(error);
      const existing = syncStore.read().watchers[repoId];
      const watcher: WatcherState = {
        ...(existing ?? { repoId, enabled: false, intervalMs: DEFAULT_INTERVAL }),
        repoId,
        lastCheckedAt: new Date().toISOString(),
        pendingReview: false,
        pendingPaths: undefined,
        lastError: message,
      };
      this.persist(watcher);
      this.logger.warn(`Sync failed for ${repoId}: ${message}`);
      return this.toState(watcher);
    } finally {
      this.busy.delete(repoId);
    }
  }

  private persist(watcher: WatcherState): void {
    syncStore.update((state) => ({
      ...state,
      watchers: { ...state.watchers, [watcher.repoId]: watcher },
    }));
  }

  private toState(watcher: WatcherState): SyncState {
    return {
      repoId: watcher.repoId,
      codeSha: watcher.lastCodeSha,
      wikiSha: watcher.lastWikiSha,
      checkedAt: watcher.lastCheckedAt,
      pendingReview: watcher.pendingReview,
    };
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
