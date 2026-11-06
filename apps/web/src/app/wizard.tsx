import {
  PROVIDER_DEFINITIONS,
  type AiProviderId,
  type ConnectedRepo,
  type GithubAccount,
  type ProviderConnection,
  type RepoSummary,
  type SetupState,
} from '@org/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';

interface WizardProps {
  initial: SetupState;
  onDone: (state: SetupState) => void;
}

export function Wizard({ initial, onDone }: WizardProps) {
  const [step, setStep] = useState(initial.providers.length > 0 ? 2 : 1);
  const [providers, setProviders] = useState(initial.providers);
  const [account, setAccount] = useState<GithubAccount | undefined>(
    initial.github,
  );
  const [repos, setRepos] = useState<ConnectedRepo[]>(initial.repos);
  const [toast, setToast] = useState<string>();

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = setTimeout(() => setToast(undefined), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const finish = async () => {
    try {
      const state = await api.completeSetup();
      onDone(state);
    } catch (error) {
      setToast(messageOf(error));
    }
  };

  return (
    <div className="wizard">
      <header className="wizard__head">
        <div className="brand">
          <span className="brand__mark">W2C</span>
          <div>
            <h1>Wiki2Code</h1>
            <p>Write the product in the wiki. Let the code catch up.</p>
          </div>
        </div>
        <ol className="steps">
          <li className={step === 1 ? 'is-active' : 'is-done'}>
            <span>1</span> AI providers
          </li>
          <li className={step === 2 ? 'is-active' : ''}>
            <span>2</span> GitHub &amp; repository
          </li>
        </ol>
      </header>

      <main className="wizard__body">
        {step === 1 ? (
          <ProviderStep
            providers={providers}
            onProviders={setProviders}
            onNext={() => setStep(2)}
            onError={setToast}
          />
        ) : (
          <GithubStep
            account={account}
            onAccount={(next) => {
              setAccount(next);
              if (next) {
                void api
                  .repos()
                  .then(setRepos)
                  .catch(() => undefined);
              }
            }}
            repos={repos}
            onRepos={setRepos}
            onBack={() => setStep(1)}
            onFinish={finish}
            onError={setToast}
          />
        )}
      </main>

      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function ProviderStep({
  providers,
  onProviders,
  onNext,
  onError,
}: {
  providers: ProviderConnection[];
  onProviders: (providers: ProviderConnection[]) => void;
  onNext: () => void;
  onError: (message: string) => void;
}) {
  const [selected, setSelected] = useState<AiProviderId>('openai');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{
    ok: boolean;
    message: string;
  }>();

  const definition = PROVIDER_DEFINITIONS.find((item) => item.id === selected);

  const connect = async () => {
    if (!definition) {
      return;
    }
    setBusy(true);
    setStatus(undefined);
    try {
      const validation = await api.validateProvider({
        provider: selected,
        apiKey: definition.requiresKey ? apiKey.trim() : undefined,
        baseUrl: baseUrl.trim() || undefined,
      });
      if (!validation.ok) {
        setStatus({ ok: false, message: validation.message });
        return;
      }
      const connection = await api.addProvider({
        provider: selected,
        apiKey: definition.requiresKey ? apiKey.trim() : undefined,
        baseUrl: baseUrl.trim() || undefined,
        label: label.trim() || undefined,
      });
      const next = await api.providers();
      onProviders(next);
      setStatus({
        ok: true,
        message: `${connection.label} connected — ${connection.models.length} models available.`,
      });
      setApiKey('');
      setLabel('');
    } catch (error) {
      setStatus({ ok: false, message: messageOf(error) });
      onError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.removeProvider(id);
      onProviders(await api.providers());
    } catch (error) {
      onError(messageOf(error));
    }
  };

  return (
    <section className="panel">
      <div className="panel__intro">
        <h2>Connect your AI providers</h2>
        <p>
          Wiki2Code verifies every key against the provider before saving it.
          Connect one or more — you can add the rest later.
        </p>
      </div>

      <div className="provider-grid">
        {PROVIDER_DEFINITIONS.map((provider) => {
          const connected = providers.filter(
            (item) => item.provider === provider.id,
          );
          return (
            <button
              key={provider.id}
              type="button"
              className={`provider-card ${
                selected === provider.id ? 'is-selected' : ''
              } ${connected.length > 0 ? 'is-connected' : ''}`}
              onClick={() => {
                setSelected(provider.id);
                setStatus(undefined);
                setBaseUrl('');
              }}
            >
              <span className="provider-card__name">{provider.name}</span>
              <span className="provider-card__meta">
                {connected.length > 0
                  ? `${connected.length} connected`
                  : provider.requiresKey
                    ? 'API key'
                    : 'Local'}
              </span>
            </button>
          );
        })}
      </div>

      {definition ? (
        <div className="form">
          {definition.requiresKey ? (
            <label className="field">
              <span>API key</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={definition.keyPlaceholder}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <small>
                Get one at{' '}
                <a href={definition.docsUrl} target="_blank" rel="noreferrer">
                  {definition.docsUrl.replace('https://', '')}
                </a>
              </small>
            </label>
          ) : (
            <p className="hint">
              {definition.name} runs locally. Make sure it is running before
              connecting.
            </p>
          )}

          <div className="form__row">
            <label className="field">
              <span>Base URL (optional)</span>
              <input
                type="text"
                placeholder={definition.defaultBaseUrl}
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Label (optional)</span>
              <input
                type="text"
                placeholder={definition.name}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
          </div>

          <button
            type="button"
            className="btn btn--primary"
            disabled={
              busy || (definition.requiresKey && apiKey.trim().length === 0)
            }
            onClick={() => void connect()}
          >
            {busy ? 'Validating…' : 'Validate & connect'}
          </button>

          {status ? (
            <p className={`status ${status.ok ? 'status--ok' : 'status--bad'}`}>
              {status.message}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="connected">
        <h3>Connected providers</h3>
        {providers.length === 0 ? (
          <p className="muted">
            No providers yet. At least one is required to continue.
          </p>
        ) : (
          <ul className="connected__list">
            {providers.map((provider) => (
              <li key={provider.id}>
                <span className="dot" />
                <div>
                  <strong>{provider.label}</strong>
                  <small>
                    {provider.apiKeyMasked} · {provider.models.length} models
                  </small>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void remove(provider.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="panel__foot">
        <span className="muted">
          {providers.length > 0
            ? 'You can connect additional providers at any time.'
            : 'Connect at least one provider to continue.'}
        </span>
        <button
          type="button"
          className="btn btn--primary"
          disabled={providers.length === 0}
          onClick={onNext}
        >
          Continue
        </button>
      </footer>
    </section>
  );
}

function GithubStep({
  account,
  onAccount,
  repos,
  onRepos,
  onBack,
  onFinish,
  onError,
}: {
  account?: GithubAccount;
  onAccount: (account?: GithubAccount) => void;
  repos: ConnectedRepo[];
  onRepos: (repos: ConnectedRepo[]) => void;
  onBack: () => void;
  onFinish: () => void;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<'device' | 'pat'>('device');
  const [clientId, setClientId] = useState(
    localStorage.getItem('w2c.clientId') ?? '',
  );
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<{
    sessionId: string;
    userCode: string;
    verificationUri: string;
    interval: number;
  }>();
  const [deviceStatus, setDeviceStatus] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [remote, setRemote] = useState<RepoSummary[]>([]);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [search, setSearch] = useState('');
  const [connecting, setConnecting] = useState<string>();
  const [finishing, setFinishing] = useState(false);

  const loadRemote = async () => {
    setLoadingRemote(true);
    try {
      setRemote(await api.remoteRepos());
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setLoadingRemote(false);
    }
  };

  useEffect(() => {
    if (account) {
      void loadRemote();
    }
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.login]);

  const startDevice = async () => {
    setBusy(true);
    setDeviceStatus(undefined);
    try {
      if (clientId.trim()) {
        localStorage.setItem('w2c.clientId', clientId.trim());
      }
      const flow = await api.deviceStart(clientId.trim() || undefined);
      setDevice(flow);
      setDeviceStatus('Waiting for you to authorize in the browser…');
      window.open(flow.verificationUri, '_blank', 'noopener');
      schedulePoll(flow.sessionId, flow.interval);
    } catch (error) {
      setDeviceStatus(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const schedulePoll = (sessionId: string, seconds: number) => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(async () => {
      try {
        const result = await api.devicePoll(sessionId);
        if (result.status === 'connected' && result.account) {
          onAccount(result.account);
          setDevice(undefined);
          setDeviceStatus('Signed in.');
          return;
        }
        if (result.status === 'pending') {
          schedulePoll(sessionId, seconds);
          return;
        }
        setDeviceStatus(result.message ?? 'Sign-in did not complete.');
        setDevice(undefined);
      } catch (error) {
        setDeviceStatus(messageOf(error));
      }
    }, Math.max(2, seconds) * 1000);
  };

  const signInWithPat = async () => {
    setBusy(true);
    try {
      const next = await api.usePat(pat.trim());
      onAccount(next);
      setPat('');
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const connect = async (repo: RepoSummary) => {
    setConnecting(repo.fullName);
    try {
      const connected = await api.connectRepo(repo.owner, repo.name);
      onRepos(await api.repos());
      if (!connected.wikiReady) {
        onError(
          connected.wikiError ??
            'Connected, but the wiki could not be loaded yet.',
        );
      }
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setConnecting(undefined);
    }
  };

  const disconnect = async (repoId: string) => {
    try {
      await api.disconnectRepo(repoId);
      onRepos(await api.repos());
    } catch (error) {
      onError(messageOf(error));
    }
  };

  const finish = async () => {
    setFinishing(true);
    try {
      await onFinish();
    } finally {
      setFinishing(false);
    }
  };

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return remote;
    }
    return remote.filter((repo) => repo.fullName.toLowerCase().includes(needle));
  }, [remote, search]);

  return (
    <section className="panel">
      <div className="panel__intro">
        <h2>Sign in to GitHub and pick a repository</h2>
        <p>
          Wiki2Code reads the repository and its wiki. Commits it creates are
          authored as the signed-in account.
        </p>
      </div>

      {account ? (
        <div className="account">
          {account.avatarUrl ? (
            <img src={account.avatarUrl} alt="" width={40} height={40} />
          ) : null}
          <div>
            <strong>{account.name ?? account.login}</strong>
            <small>@{account.login}</small>
          </div>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={async () => {
              await api.logout();
              onAccount(undefined);
              onRepos([]);
              setRemote([]);
            }}
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="signin">
          <div className="tabs">
            <button
              type="button"
              className={mode === 'device' ? 'is-active' : ''}
              onClick={() => setMode('device')}
            >
              Device flow
            </button>
            <button
              type="button"
              className={mode === 'pat' ? 'is-active' : ''}
              onClick={() => setMode('pat')}
            >
              Personal access token
            </button>
          </div>

          {mode === 'device' ? (
            <div className="form">
              <label className="field">
                <span>OAuth App client ID</span>
                <input
                  type="text"
                  spellCheck={false}
                  placeholder="Iv1.0123456789abcdef"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                />
                <small>
                  Create a free OAuth App at{' '}
                  <a
                    href="https://github.com/settings/applications/new"
                    target="_blank"
                    rel="noreferrer"
                  >
                    github.com/settings/applications/new
                  </a>{' '}
                  and enable device flow. Or use a personal access token
                  instead.
                </small>
              </label>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || Boolean(device)}
                onClick={() => void startDevice()}
              >
                {device ? 'Waiting…' : 'Start GitHub sign-in'}
              </button>

              {device ? (
                <div className="device-code">
                  <span>Enter this code on GitHub</span>
                  <strong>{device.userCode}</strong>
                  <a href={device.verificationUri} target="_blank" rel="noreferrer">
                    Open {device.verificationUri.replace('https://', '')}
                  </a>
                </div>
              ) : null}
              {deviceStatus ? <p className="hint">{deviceStatus}</p> : null}
            </div>
          ) : (
            <div className="form">
              <label className="field">
                <span>Personal access token</span>
                <input
                  type="password"
                  spellCheck={false}
                  placeholder="ghp_… or github_pat_…"
                  value={pat}
                  onChange={(event) => setPat(event.target.value)}
                />
                <small>
                  Needs <code>repo</code> scope. Classic and fine-grained tokens
                  both work.
                </small>
              </label>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || pat.trim().length === 0}
                onClick={() => void signInWithPat()}
              >
                {busy ? 'Checking…' : 'Sign in with token'}
              </button>
            </div>
          )}
        </div>
      )}

      {account ? (
        <div className="repo-picker">
          <div className="repo-picker__head">
            <h3>Repositories</h3>
            <input
              type="search"
              placeholder="Filter repositories…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void loadRemote()}
              disabled={loadingRemote}
            >
              {loadingRemote ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          <ul className="repo-list">
            {filtered.map((repo) => {
              const connected = repos.some(
                (item) => item.fullName === repo.fullName,
              );
              return (
                <li key={repo.id} className={connected ? 'is-connected' : ''}>
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
                    disabled={connected || connecting === repo.fullName}
                    onClick={() => void connect(repo)}
                  >
                    {connected
                      ? 'Connected'
                      : connecting === repo.fullName
                        ? 'Cloning…'
                        : 'Connect'}
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 ? (
              <li className="muted">
                {loadingRemote ? 'Loading repositories…' : 'No repositories found.'}
              </li>
            ) : null}
          </ul>

          {repos.length > 0 ? (
            <div className="connected">
              <h3>Connected repositories</h3>
              <ul className="connected__list">
                {repos.map((repo) => (
                  <li key={repo.repoId}>
                    <span className="dot" />
                    <div>
                      <strong>{repo.fullName}</strong>
                      <small>
                        {repo.wikiPageCount} wiki page
                        {repo.wikiPageCount === 1 ? '' : 's'}
                        {repo.wikiReady ? '' : ' · wiki pending'}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => void disconnect(repo.repoId)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <footer className="panel__foot">
        <button type="button" className="btn btn--ghost" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!account || repos.length === 0 || finishing}
          onClick={() => void finish()}
        >
          {finishing ? 'Opening workspace…' : 'Enter workspace'}
        </button>
      </footer>
    </section>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
