import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  AI_PATTERNS,
  DEFAULT_PORTS,
  GITHUB_PATTERNS,
  REVIEW_PATTERNS,
  type ConnectedRepo,
  type ReviewJob,
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
const MIN_INTERVAL = 15_000;

@Injectable()
export class SyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncService.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly busy = new Set<string>();
  private readonly github = createTcpClient(
    Number(process.env.GITHUB_SVC_PORT ?? DEFAULT_PORTS.github),
  );
  private readonly reviews = createTcpClient(
    Number(process.env.REVIEW_SVC_PORT ?? DEFAULT_PORTS.review),
  );
  private readonly ai = createTcpClient(
    Number(process.env.AI_SVC_PORT ?? DEFAULT_PORTS.ai),
  );

  async onModuleInit(): Promise<void> {
    try {
      const repos = await sendTo<ConnectedRepo[]>(
        this.github,
        GITHUB_PATTERNS.REPO_LIST,
        {},
      );
      const watchers = syncStore.read().watchers;
      for (const repo of repos) {
        const existing = watchers[repo.repoId];
        if (existing && existing.enabled) {
          this.startTimer(existing);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Could not restore watchers at startup: ${this.describe(error)}`,
      );
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  start(payload: {
    repoId: string;
    intervalMs?: number;
    immediate?: boolean;
  }): SyncState {
    const intervalMs = Math.max(
      MIN_INTERVAL,
      Number(payload.intervalMs) || DEFAULT_INTERVAL,
    );
    const watcher: WatcherState = {
      ...(syncStore.read().watchers[payload.repoId] ?? {
        pendingReview: false,
      }),
      repoId: payload.repoId,
      enabled: true,
      intervalMs,
    };
    this.persist(watcher);
    this.startTimer(watcher);
    if (payload.immediate !== false) {
      void this.tick({ repoId: payload.repoId });
    }
    return this.toState(watcher);
  }

  stop(payload: { repoId: string }): SyncState {
    const timer = this.timers.get(payload.repoId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(payload.repoId);
    }
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

      let pendingReview = false;

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

      if (poll.wikiChanged) {
        this.logger.log(`Wiki changed in ${repoId}; scheduling review`);
        pendingReview = true;
        await this.triggerReview(repoId, undefined);
        pendingReview = false;
      } else if (poll.codeChanged && poll.changedPaths.length > 0) {
        await this.triggerReview(repoId, poll.changedPaths);
      }

      const existing = syncStore.read().watchers[repoId];
      const watcher: WatcherState = {
        ...(existing ?? { repoId, enabled: true, intervalMs: DEFAULT_INTERVAL }),
        repoId,
        lastCheckedAt: new Date().toISOString(),
        lastCodeSha: poll.codeSha ?? existing?.lastCodeSha,
        lastWikiSha: poll.wikiSha ?? existing?.lastWikiSha,
        pendingReview,
        lastError: undefined,
      };
      this.persist(watcher);
      return this.toState(watcher);
    } catch (error) {
      const message = this.describe(error);
      const existing = syncStore.read().watchers[repoId];
      const watcher: WatcherState = {
        ...(existing ?? { repoId, enabled: true, intervalMs: DEFAULT_INTERVAL }),
        repoId,
        lastCheckedAt: new Date().toISOString(),
        pendingReview: false,
        lastError: message,
      };
      this.persist(watcher);
      this.logger.warn(`Watcher tick failed for ${repoId}: ${message}`);
      return this.toState(watcher);
    } finally {
      this.busy.delete(repoId);
    }
  }

  private async triggerReview(
    repoId: string,
    changedPaths: string[] | undefined,
  ): Promise<void> {
    const model = await this.selectedModel();
    if (!model) {
      this.logger.warn(
        `Skipping automatic review for ${repoId}: no AI provider connected`,
      );
      return;
    }
    try {
      const job = await sendTo<ReviewJob>(this.ai, AI_PATTERNS.REVIEW_START, {
        repoId,
        model,
        incremental: true,
        changedPaths,
      });
      this.logger.log(`Started review ${job.id} for ${repoId}`);
    } catch (error) {
      this.logger.warn(
        `Could not start automatic review for ${repoId}: ${this.describe(error)}`,
      );
    }
  }

  private async selectedModel(): Promise<string | undefined> {
    try {
      const result = await sendTo<{ selectedModel?: string }>(
        this.ai,
        AI_PATTERNS.MODELS_LIST,
        {},
      );
      return result.selectedModel;
    } catch {
      return undefined;
    }
  }

  private startTimer(watcher: WatcherState): void {
    const existing = this.timers.get(watcher.repoId);
    if (existing) {
      clearInterval(existing);
    }
    const timer = setInterval(() => {
      void this.tick({ repoId: watcher.repoId });
    }, watcher.intervalMs);
    timer.unref?.();
    this.timers.set(watcher.repoId, timer);
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
      checkedAt: watcher.lastCheckedAt ?? new Date(0).toISOString(),
      pendingReview: watcher.pendingReview,
    };
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
