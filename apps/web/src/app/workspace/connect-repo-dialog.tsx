import type { ConnectedRepo, RepoSummary } from '@org/contracts';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';

export function ConnectRepoDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (repo: ConnectedRepo) => void;
}) {
  const [remote, setRemote] = useState<RepoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [connecting, setConnecting] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void api
      .remoteRepos()
      .then((repos) => {
        if (!cancelled) {
          setRemote(repos);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(messageOf(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return remote;
    }
    return remote.filter((repo) => repo.fullName.toLowerCase().includes(needle));
  }, [remote, search]);

  const connect = async (repo: RepoSummary) => {
    setConnecting(repo.fullName);
    setError(undefined);
    try {
      const connected = await api.connectRepo(repo.owner, repo.name);
      onConnected(connected);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setConnecting(undefined);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal__head">
          <div>
            <h2>Connect a repository</h2>
            <p className="muted">
              Clones the code and its wiki. Wikis are enabled automatically when
              missing.
            </p>
          </div>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <input
          type="search"
          className="modal__search"
          placeholder="Filter repositories…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoFocus
        />

        {error ? <p className="status status--bad">{error}</p> : null}

        <ul className="repo-list repo-list--modal">
          {filtered.map((repo) => (
            <li key={repo.id}>
              <div>
                <strong>{repo.fullName}</strong>
                <small>
                  {repo.private ? 'Private' : 'Public'}
                  {repo.hasWiki ? ' · wiki enabled' : ' · wiki will be enabled'}
                </small>
              </div>
              <button
                type="button"
                className="btn btn--small"
                disabled={connecting === repo.fullName}
                onClick={() => void connect(repo)}
              >
                {connecting === repo.fullName ? 'Cloning…' : 'Connect'}
              </button>
            </li>
          ))}
          {!loading && filtered.length === 0 ? (
            <li className="muted">No repositories found.</li>
          ) : null}
          {loading ? <li className="muted">Loading repositories…</li> : null}
        </ul>
      </div>
    </div>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
