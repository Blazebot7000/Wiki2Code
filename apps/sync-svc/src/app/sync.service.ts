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
  private destroyed = false;
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
    await this.restoreWatchers(0);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  /**
   * github-svc may still be booting when this service starts. Retry with
   * backoff instead of giving up on the first failure, otherwise a normal
   * startup race leaves commit monitoring disabled for the whole session.
   */
  private async restoreWatchers(attempt: number): Promise<void> {
    if (this.destroyed) {
      return;
    }
    try {
      const repos = await sendTo<ConnectedRepo[]>(
        this.github,
        GITHUB_PATTERNS.REPO_LIST,
        {},
      );
      const watchers = syncStore.read().watchers;
      for (const repo of repos) {
        const existing = watchers[repo.repoId];
        if (existing?.enabled) {
          this.startTimer(existing);
        } else if (!existing) {
          // Every connected repository should be monitored, even if its
          // watcher record was lost.
          this.start({ repoId: repo.repoId, immediate: false });
        }
      }
      if (repos.length > 0) {
        this.logger.log(
          `Restored commit monitoring for ${repos.length} repositories`,
        );
      }
    } catch (error) {
      if (this.destroyed) {
        return;
      }
      const delay = Math.min(30_000, 1_000 * 2 ** attempt);
      if (attempt >= 6) {
        this.logger.warn(
          `Could not restore watchers: ${this.describe(error)}`,
        );
        return;
      }
      this.logger.warn(
        `Could not restore watchers yet (${this.describe(error)}); retrying in ${delay}ms`,
      );
      const timer = setTimeout(
        () => void this.restoreWatchers(attempt + 1),
        delay,
      );
      timer.unref?.();
    }
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

      const existing = syncStore.read().watchers[repoId];
      const inheritedPending = existing?.pendingReview === true;
      const inheritedPaths =
        inheritedPending && existing?.pendingPaths?.length
          ? existing.pendingPaths
          : undefined;

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

      // A change that was detected but could not be reviewed (no AI provider
      // yet, ai-svc still booting, provider rate limit) stays pending so the
      // next tick retries it instead of consuming the commit silently. A code
      // change with no diff (first clone, recovered checkout) triggers a full
      // review because there is no path list to narrow it down with.
      const changeNeedsReview = poll.wikiChanged || poll.codeChanged;
      const needsReview = inheritedPending || changeNeedsReview;
      // Carry still-unreviewed paths forward, so a second commit does not hide
      // the files from the first one that never got reviewed.
      const pendingPaths = poll.wikiChanged
        ? undefined
        : [
            ...new Set([
              ...(inheritedPaths ?? []),
              ...poll.changedPaths,
            ]),
          ];
      const reviewPaths =
        pendingPaths && pendingPaths.length > 0 ? pendingPaths : undefined;
      let reviewStarted = false;

      if (needsReview) {
        reviewStarted = await this.triggerReview(repoId, reviewPaths);
        if (!reviewStarted) {
          this.logger.log(
            `Review for ${repoId} is pending; it will be retried on the next tick.`,
          );
        }
      }

      const pendingReview = needsReview && !reviewStarted;

      const watcher: WatcherState = {
        ...(existing ?? { repoId, enabled: true, intervalMs: DEFAULT_INTERVAL }),
        repoId,
        lastCheckedAt: new Date().toISOString(),
        lastCodeSha: poll.codeSha ?? existing?.lastCodeSha,
        lastWikiSha: poll.wikiSha ?? existing?.lastWikiSha,
        pendingReview,
        pendingPaths: pendingReview ? pendingPaths : undefined,
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
        // Keep a pending review pending across a failing poll so it is not lost.
        pendingReview: existing?.pendingReview ?? false,
        pendingPaths: existing?.pendingPaths,
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
  ): Promise<boolean> {
    // Never run two reviews of the same repository at once: whichever one
    // finished last would overwrite the other's page highlights. Keep the
    // change pending and start it from the next tick instead.
    try {
      const jobs = await sendTo<ReviewJob[]>(
        this.reviews,
        REVIEW_PATTERNS.JOBS_LIST,
        { repoId },
      );
      if (
        jobs.some(
          (job) => job.status === 'queued' || job.status === 'running',
        )
      ) {
        this.logger.log(
          `A review is already running for ${repoId}; deferring the next one.`,
        );
        return false;
      }
    } catch {
      // If the review service is unreachable, fall through and let the start
      // call report the real error.
    }
    const model = await this.selectedModel();
    if (!model) {
      this.logger.warn(
        `Skipping automatic review for ${repoId}: no AI provider connected`,
      );
      return false;
    }
    try {
      const job = await sendTo<ReviewJob>(this.ai, AI_PATTERNS.REVIEW_START, {
        repoId,
        model,
        incremental: true,
        changedPaths,
      });
      this.logger.log(`Started review ${job.id} for ${repoId}`);
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not start automatic review for ${repoId}: ${this.describe(error)}`,
      );
      return false;
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
