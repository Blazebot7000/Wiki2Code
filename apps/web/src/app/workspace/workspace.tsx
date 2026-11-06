import type {
  ConnectedRepo,
  DevCycleJob,
  Highlight,
  ModelInfo,
  ReviewJob,
  SetupState,
  SyncState,
  WikiPage,
  WikiPageMeta,
} from '@org/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, eventsUrl } from '../api';
import { ConnectRepoDialog } from './connect-repo-dialog';
import { DevJobDialog } from './job-dialog';
import { ModelSwitcher } from './model-switcher';
import { WikiPageView } from './wiki-page';

interface WorkspaceProps {
  initial: SetupState;
  onReset: () => void;
}

interface Digest {
  review?: {
    id: string;
    status: ReviewJob['status'];
    stage: string;
    progress: number;
    total: number;
    highlightCount: number;
    error?: string;
  };
  highlights?: { version: number; open: number; total: number };
  sync?: SyncState;
}

export function Workspace({ initial, onReset }: WorkspaceProps) {
  const [repos, setRepos] = useState(initial.repos);
  const [activeRepoId, setActiveRepoId] = useState(
    initial.activeRepoId ?? initial.repos[0]?.repoId,
  );
  const [pages, setPages] = useState<WikiPageMeta[]>([]);
  const [slug, setSlug] = useState<string>();
  const [page, setPage] = useState<WikiPage>();
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState(initial.selectedModel);
  const [job, setJob] = useState<ReviewJob>();
  const [syncState, setSyncState] = useState<SyncState>();
  const [loadingPage, setLoadingPage] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [toast, setToast] = useState<string>();
  const [busyHighlightId, setBusyHighlightId] = useState<string>();
  const [devJob, setDevJob] = useState<DevCycleJob>();
  const [showDevJob, setShowDevJob] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [startingReview, setStartingReview] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const highlightsVersion = useRef(-1);
  const activeRepo = repos.find((repo) => repo.repoId === activeRepoId);

  useEffect(() => {
    void api
      .models()
      .then((result) => {
        setModels(result.models);
        if (result.selectedModel) {
          setSelectedModel(result.selectedModel);
        }
      })
      .catch((error) => setToast(messageOf(error)));
  }, []);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = setTimeout(() => setToast(undefined), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!activeRepoId) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await api.activateRepo(activeRepoId).catch(() => undefined);
        const [nextPages, nextSync] = await Promise.all([
          api.wikiPages(activeRepoId),
          api.syncState(activeRepoId).catch(() => undefined),
        ]);
        if (cancelled) {
          return;
        }
        setPages(nextPages);
        setSyncState(nextSync);
        setSlug(nextPages[0]?.slug);
        if (nextPages.length === 0) {
          setPage(undefined);
          setHighlights([]);
        }
      } catch (error) {
        if (!cancelled) {
          setToast(messageOf(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeRepoId]);

  useEffect(() => {
    if (!activeRepoId || !slug) {
      return;
    }
    let cancelled = false;
    setLoadingPage(true);
    void (async () => {
      try {
        const [nextPage, nextHighlights] = await Promise.all([
          api.wikiPage(activeRepoId, slug),
          api.highlights(activeRepoId, slug),
        ]);
        if (cancelled) {
          return;
        }
        setPage(nextPage);
        setHighlights(nextHighlights);
      } catch (error) {
        if (!cancelled) {
          setToast(messageOf(error));
          setPage(undefined);
          setHighlights([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingPage(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeRepoId, slug, reloadToken]);

  useEffect(() => {
    if (!activeRepoId) {
      return;
    }
    const source = new EventSource(eventsUrl(activeRepoId));
    source.onmessage = (event) => {
      try {
        const digest = JSON.parse(event.data) as Digest;
        if (digest.sync) {
          setSyncState(digest.sync);
        }
        if (digest.review) {
          const next = digest.review;
          setJob((current) => {
            if (current && current.id === next.id) {
              return { ...current, ...next };
            }
            return {
              ...next,
              repoId: activeRepoId,
              model: current?.model ?? selectedModel ?? '',
              startedAt: current?.startedAt ?? new Date().toISOString(),
            } as ReviewJob;
          });
        }
        if (
          digest.highlights &&
          digest.highlights.version !== highlightsVersion.current
        ) {
          highlightsVersion.current = digest.highlights.version;
          setReloadToken((value) => value + 1);
        }
      } catch {
        // ignore malformed events
      }
    };
    return () => source.close();
  }, [activeRepoId, selectedModel]);

  useEffect(() => {
    if (!job || (job.status !== 'running' && job.status !== 'queued')) {
      return;
    }
    const timer = setInterval(() => {
      void api
        .review(job.id)
        .then((next) => {
          if (next) {
            setJob(next);
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!devJob || devJob.status !== 'running') {
      return;
    }
    const timer = setInterval(() => {
      void api
        .devJob(devJob.id)
        .then((next) => {
          if (next) {
            setDevJob(next);
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [devJob?.id, devJob?.status]);

  const refreshRepo = useCallback(async () => {
    setRepos(await api.repos());
  }, []);

  const refreshPages = useCallback(async () => {
    if (!activeRepoId) {
      return;
    }
    const nextPages = await api.wikiPages(activeRepoId);
    setPages(nextPages);
    if (!nextPages.some((item) => item.slug === slug)) {
      setSlug(nextPages[0]?.slug);
    }
  }, [activeRepoId, slug]);

  const changeModel = async (model: string) => {
    const previous = selectedModel;
    setSelectedModel(model);
    try {
      await api.selectModel(model);
    } catch (error) {
      setSelectedModel(previous);
      setToast(messageOf(error));
    }
  };

  const startReview = async () => {
    if (!activeRepoId) {
      return;
    }
    setStartingReview(true);
    try {
      const created = await api.startReview(activeRepoId, {
        model: selectedModel,
      });
      setJob(created);
      setToast('Review started. Highlights will appear as pages are checked.');
    } catch (error) {
      setToast(messageOf(error));
    } finally {
      setStartingReview(false);
    }
  };

  const syncNow = async () => {
    if (!activeRepoId) {
      return;
    }
    setSyncing(true);
    try {
      const repo = await api.syncRepo(activeRepoId);
      setRepos((current) =>
        current.map((item) => (item.repoId === repo.repoId ? repo : item)),
      );
      await api.syncNow(activeRepoId).catch(() => undefined);
      await refreshPages();
      setReloadToken((value) => value + 1);
      setToast('Repository synced from GitHub.');
    } catch (error) {
      setToast(messageOf(error));
    } finally {
      setSyncing(false);
    }
  };

  const fixWiki = async (highlight: Highlight) => {
    setBusyHighlightId(highlight.id);
    try {
      const result = await api.fixWiki(highlight.id, selectedModel);
      setToast(`Wiki updated in commit ${result.commitSha.slice(0, 7)}.`);
      await refreshPages();
      setReloadToken((value) => value + 1);
    } catch (error) {
      setToast(messageOf(error));
    } finally {
      setBusyHighlightId(undefined);
    }
  };

  const fixCode = async (highlight: Highlight) => {
    setBusyHighlightId(highlight.id);
    try {
      setToast('Planning the change against the documentation…');
      const created = await api.fixCode(highlight.id, {
        model: selectedModel,
      });
      setDevJob(created);
      setShowDevJob(true);
    } catch (error) {
      setToast(messageOf(error));
    } finally {
      setBusyHighlightId(undefined);
    }
  };

  const dismiss = async (highlight: Highlight) => {
    try {
      await api.updateHighlight(highlight.id, 'dismissed');
      setReloadToken((value) => value + 1);
    } catch (error) {
      setToast(messageOf(error));
    }
  };

  const disconnect = async (repo: ConnectedRepo) => {
    if (!window.confirm(`Disconnect ${repo.fullName}? Local clones are removed.`)) {
      return;
    }
    try {
      await api.disconnectRepo(repo.repoId);
      const next = await api.repos();
      setRepos(next);
      if (repo.repoId === activeRepoId) {
        setActiveRepoId(next[0]?.repoId);
      }
    } catch (error) {
      setToast(messageOf(error));
    }
  };

  const resetSetup = async () => {
    if (
      !window.confirm(
        'Reset setup? This signs out of GitHub, removes connected repositories and providers, and deletes local clones.',
      )
    ) {
      return;
    }
    try {
      await api.resetSetup();
      onReset();
    } catch (error) {
      setToast(messageOf(error));
    }
  };

  const openHighlights = highlights.filter(
    (item) => item.status === 'open' || item.status === 'stale',
  );
  const progress =
    job && job.total > 0
      ? Math.min(100, Math.round((job.progress / job.total) * 100))
      : 0;
  const reviewRunning =
    job && (job.status === 'running' || job.status === 'queued');

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="brand__mark">W2C</span>
          <span>Wiki2Code</span>
        </div>

        <div className="sidebar__head">
          <span>Repositories</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setConnectOpen(true)}
            title="Connect a repository"
          >
            +
          </button>
        </div>

        <nav className="repo-tabs">
          {repos.map((repo) => (
            <div
              key={repo.repoId}
              className={`repo-tab ${
                repo.repoId === activeRepoId ? 'is-active' : ''
              }`}
            >
              <button
                type="button"
                className="repo-tab__main"
                onClick={() => setActiveRepoId(repo.repoId)}
              >
                <span className="repo-tab__owner">{repo.owner}</span>
                <span className="repo-tab__name">{repo.name}</span>
                <span className="repo-tab__meta">
                  {repo.wikiReady
                    ? `${repo.wikiPageCount} page${
                        repo.wikiPageCount === 1 ? '' : 's'
                      }`
                    : 'wiki pending'}
                </span>
              </button>
              <button
                type="button"
                className="repo-tab__remove"
                title="Disconnect"
                onClick={() => void disconnect(repo)}
              >
                ×
              </button>
            </div>
          ))}
          {repos.length === 0 ? (
            <p className="muted sidebar__empty">
              No repositories connected. Use + to add one.
            </p>
          ) : null}
        </nav>

        <footer className="sidebar__foot">
          <button type="button" className="btn btn--ghost btn--small" onClick={() => void resetSetup()}>
            Reset setup
          </button>
        </footer>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar__title">
            <span className="muted">{activeRepo?.fullName ?? 'No repository'}</span>
            {page ? <h1>{page.title}</h1> : null}
          </div>

          <div className="topbar__actions">
            {devJob && devJob.status === 'running' ? (
              <button
                type="button"
                className="chip chip--live"
                onClick={() => setShowDevJob(true)}
              >
                <span className="spinner" />
                {devJob.stage}
              </button>
            ) : null}

            <span className="sync-badge" title={syncState?.checkedAt}>
              <span className="dot dot--live" />
              {syncState?.checkedAt
                ? `Checked ${timeAgo(syncState.checkedAt)}`
                : 'Not checked yet'}
            </span>

            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => void syncNow()}
              disabled={!activeRepoId || syncing}
            >
              {syncing ? 'Syncing…' : 'Sync'}
            </button>

            <ModelSwitcher
              models={models}
              selected={selectedModel}
              onChange={(model) => void changeModel(model)}
              disabled={Boolean(reviewRunning)}
            />

            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void startReview()}
              disabled={!activeRepoId || Boolean(reviewRunning) || startingReview}
            >
              {reviewRunning ? 'Reviewing…' : 'Review wiki'}
            </button>
          </div>
        </header>

        {reviewRunning ? (
          <div className="review-strip">
            <span className="spinner" />
            <span className="review-strip__stage">{job?.stage}</span>
            <div className="bar">
              <div className="bar__fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="muted">
              {job?.progress ?? 0}/{job?.total || '…'}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => void api.cancelReview(job!.id).catch(() => undefined)}
            >
              Cancel
            </button>
          </div>
        ) : job ? (
          <div
            className={`review-strip ${
              job.status === 'failed' ? 'review-strip--bad' : 'review-strip--done'
            }`}
          >
            <span>
              {job.status === 'failed'
                ? `Review failed: ${job.error ?? 'unknown error'}`
                : `Review complete — ${job.highlightCount} finding${
                    job.highlightCount === 1 ? '' : 's'
                  }.`}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => setJob(undefined)}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {activeRepo && !activeRepo.wikiReady ? (
          <div className="banner banner--warn">
            <strong>The wiki is not available locally yet.</strong>
            <span>
              {activeRepo.wikiError ??
                'Create the first wiki page on GitHub, then press Sync.'}
            </span>
            <a
              className="btn btn--small"
              href={`${activeRepo.htmlUrl}/wiki/_new`}
              target="_blank"
              rel="noreferrer"
            >
              Create first page
            </a>
          </div>
        ) : null}

        {pages.length > 0 ? (
          <nav className="page-tabs">
            {pages.map((item) => (
              <button
                key={item.slug}
                type="button"
                className={`page-tab ${item.slug === slug ? 'is-active' : ''}`}
                onClick={() => setSlug(item.slug)}
              >
                {item.title}
              </button>
            ))}
          </nav>
        ) : null}

        <div className="content">
          {loadingPage ? (
            <div className="loading">
              <span className="spinner" /> Loading page…
            </div>
          ) : page ? (
            <WikiPageView
              page={page}
              highlights={openHighlights}
              busyHighlightId={busyHighlightId}
              onFixWiki={(highlight) => void fixWiki(highlight)}
              onFixCode={(highlight) => void fixCode(highlight)}
              onDismiss={(highlight) => void dismiss(highlight)}
            />
          ) : pages.length === 0 ? (
            <div className="empty">
              <h2>No wiki pages yet</h2>
              <p>
                {activeRepo?.fullName ?? 'This repository'} has an empty wiki.
                Create the first page on GitHub, then sync — Wiki2Code will pick
                it up and start watching commits.
              </p>
              <div className="empty__actions">
                {activeRepo ? (
                  <a
                    className="btn btn--primary"
                    href={`${activeRepo.htmlUrl}/wiki/_new`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Create first wiki page
                  </a>
                ) : null}
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void syncNow()}
                  disabled={syncing}
                >
                  {syncing ? 'Syncing…' : 'Sync now'}
                </button>
              </div>
            </div>
          ) : (
            <div className="loading">Select a page.</div>
          )}
        </div>

        <footer className="statusbar">
          <span>
            {openHighlights.length} finding
            {openHighlights.length === 1 ? '' : 's'} on this page
          </span>
          <span className="muted">
            {highlights.filter((item) => item.status === 'stale').length} stale ·
            model {selectedModel ?? 'none'}
          </span>
        </footer>
      </main>

      {connectOpen ? (
        <ConnectRepoDialog
          onClose={() => setConnectOpen(false)}
          onConnected={(repo) => {
            setConnectOpen(false);
            void refreshRepo().then(() => setActiveRepoId(repo.repoId));
          }}
        />
      ) : null}

      {devJob && showDevJob ? (
        <DevJobDialog job={devJob} onClose={() => setShowDevJob(false)} />
      ) : null}

      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return 'just now';
  }
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) {
    return 'just now';
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`;
  }
  if (seconds < 86_400) {
    return `${Math.round(seconds / 3600)}h ago`;
  }
  return `${Math.round(seconds / 86_400)}d ago`;
}
