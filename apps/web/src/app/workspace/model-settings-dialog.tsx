import {
  PROVIDER_DEFINITIONS,
  modelKey,
  type AiProviderId,
  type ModelInfo,
  type ModelsState,
  type ProviderConnection,
} from '@org/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { api, ApiError } from '../api';

interface ModelSettingsDialogProps {
  allModels: ModelInfo[];
  hiddenModels: string[];
  reviewRunning?: boolean;
  onClose: () => void;
  onSaved: (state: ModelsState) => void;
  onModelsChanged: (state: ModelsState) => void;
}

type SettingsTab = 'models' | 'providers';

const providerName = (id: string) =>
  PROVIDER_DEFINITIONS.find((provider) => provider.id === id)?.name ?? id;

interface ModelGroup {
  key: string;
  heading: string;
  subheading?: string;
  models: ModelInfo[];
}

function groupModels(models: ModelInfo[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const model of models) {
    const key = model.connectionId ?? model.provider;
    const label = model.providerLabel?.trim() || providerName(model.provider);
    const provider = providerName(model.provider);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        heading: label,
        subheading:
          label.toLowerCase() === provider.toLowerCase() ? undefined : provider,
        models: [],
      };
      groups.set(key, group);
    }
    group.models.push(model);
  }
  return Array.from(groups.values());
}

export function ModelSettingsDialog({
  allModels,
  hiddenModels,
  reviewRunning = false,
  onClose,
  onSaved,
  onModelsChanged,
}: ModelSettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>('models');
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(hiddenModels),
  );
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [providers, setProviders] = useState<ProviderConnection[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string>();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Remember the control that opened the dialog so closing it returns the
  // user to where they were, whether they save, cancel, press Escape or
  // click the backdrop.
  const restoreFocus = useRef<HTMLElement | null>(
    typeof document !== 'undefined'
      ? (document.activeElement as HTMLElement | null)
      : null,
  );
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let cancelled = false;
    void api
      .providers()
      .then((next) => {
        if (!cancelled) {
          setProviders(next);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setProvidersError(messageOf(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setProvidersLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const node = dialogRef.current;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !node) {
        return;
      }
      const focusable = Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      restoreFocus.current?.focus?.();
    };
  }, []);

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = needle
      ? allModels.filter(
          (model) =>
            model.label.toLowerCase().includes(needle) ||
            model.id.toLowerCase().includes(needle),
        )
      : allModels;
    return groupModels(matches);
  }, [allModels, search]);

  const visibleCount = allModels.length - hidden.size;
  const allHidden = allModels.length > 0 && visibleCount === 0;
  const disabled = saving || allHidden;

  const toggle = (model: ModelInfo) => {
    const key = modelKey(model);
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const setGroup = (group: ModelGroup, show: boolean) => {
    setHidden((current) => {
      const next = new Set(current);
      for (const model of group.models) {
        const key = modelKey(model);
        if (show) {
          next.delete(key);
        } else {
          next.add(key);
        }
      }
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const state = await api.setModelVisibility(Array.from(hidden));
      onSaved(state);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const refreshProviderState = async () => {
    try {
      setProviders(await api.providers());
    } catch {
      // Keep the previous list; the next refresh will pick it up.
    }
    try {
      const state = await api.models();
      setHidden(new Set(state.hiddenModels));
      onModelsChanged(state);
    } catch {
      // The provider change already succeeded; the workspace can refetch later.
    }
  };

  const addProvider = async (payload: {
    provider: AiProviderId;
    apiKey?: string;
    baseUrl?: string;
    label?: string;
  }) => {
    const connection = await api.addProvider(payload);
    await refreshProviderState();
    return connection;
  };

  const removeProvider = async (id: string) => {
    await api.removeProvider(id);
    await refreshProviderState();
  };

  const switchTab = (next: SettingsTab) => {
    setTab(next);
    document.getElementById(`settings-tab-${next}`)?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    switchTab(tab === 'models' ? 'providers' : 'models');
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal model-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <div>
            <h2 id="model-settings-title">Settings</h2>
            <p className="muted">
              Choose which models appear in the dropdown, and connect or remove
              AI providers. Provider keys are stored encrypted.
            </p>
          </div>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="Close settings"
          >
            ×
          </button>
        </header>

        <div
          className="tabs model-settings__tabs"
          role="tablist"
          aria-label="Settings sections"
          onKeyDown={onTabKeyDown}
        >
          <button
            id="settings-tab-models"
            type="button"
            role="tab"
            aria-selected={tab === 'models'}
            aria-controls="settings-panel-models"
            tabIndex={tab === 'models' ? 0 : -1}
            className={tab === 'models' ? 'is-active' : ''}
            onClick={() => setTab('models')}
          >
            Models
          </button>
          <button
            id="settings-tab-providers"
            type="button"
            role="tab"
            aria-selected={tab === 'providers'}
            aria-controls="settings-panel-providers"
            tabIndex={tab === 'providers' ? 0 : -1}
            className={tab === 'providers' ? 'is-active' : ''}
            onClick={() => setTab('providers')}
          >
            Providers
            {providers.length > 0 ? ` (${providers.length})` : ''}
          </button>
        </div>

        <div
          id="settings-panel-models"
          role="tabpanel"
          aria-labelledby="settings-tab-models"
          hidden={tab !== 'models'}
          className="model-settings__panel model-settings__panel--models"
        >
          <div className="model-settings__toolbar">
            <input
              type="search"
              className="modal__search"
              placeholder="Filter models…"
              aria-label="Filter models"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              autoFocus
            />
            <div className="model-settings__actions">
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => setHidden(new Set())}
              >
                Show all
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() =>
                  setHidden(new Set(allModels.map((model) => modelKey(model))))
                }
              >
                Hide all
              </button>
            </div>
          </div>

          <p className="model-settings__count" role="status">
            {visibleCount} of {allModels.length} models visible
          </p>

          {error ? <p className="status status--bad">{error}</p> : null}
          {allHidden ? (
            <p className="status status--warn">
              Keep at least one model visible so reviews and fixes can run.
            </p>
          ) : null}

          <div className="model-settings__groups">
            {groups.map((group) => {
              const groupVisible = group.models.filter(
                (model) => !hidden.has(modelKey(model)),
              ).length;
              return (
                <section key={group.key} className="model-settings__group">
                  <header className="model-settings__group-head">
                    <div>
                      <strong>{group.heading}</strong>
                      {group.subheading ? (
                        <span className="muted"> {group.subheading}</span>
                      ) : null}
                      <span className="model-settings__group-count">
                        {groupVisible}/{group.models.length}
                      </span>
                    </div>
                    <div className="model-settings__group-actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        onClick={() => setGroup(group, true)}
                      >
                        Show
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        onClick={() => setGroup(group, false)}
                      >
                        Hide
                      </button>
                    </div>
                  </header>
                  <ul className="model-settings__list">
                    {group.models.map((model) => {
                      const key = modelKey(model);
                      return (
                        <li key={key}>
                          <label className="model-settings__row">
                            <input
                              type="checkbox"
                              checked={!hidden.has(key)}
                              onChange={() => toggle(model)}
                            />
                            <span className="model-settings__label">
                              {model.label}
                            </span>
                            <span className="model-settings__tags">
                              {model.free ? (
                                <span className="tag tag--free">Free</span>
                              ) : null}
                              {model.recommended ? (
                                <span className="tag tag--star">
                                  ★ Recommended
                                </span>
                              ) : null}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
            {groups.length === 0 ? (
              <div className="model-settings__empty">
                {allModels.length === 0 ? (
                  <>
                    <p className="muted">
                      No models are available yet. Connect a provider to get
                      started.
                    </p>
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => switchTab('providers')}
                    >
                      Connect a provider
                    </button>
                  </>
                ) : (
                  <p className="muted">No models match that filter.</p>
                )}
              </div>
            ) : null}
          </div>
        </div>

        <div
          id="settings-panel-providers"
          role="tabpanel"
          aria-labelledby="settings-tab-providers"
          hidden={tab !== 'providers'}
          className="model-settings__panel model-settings__panel--providers"
        >
          <ProviderSettings
            providers={providers}
            loading={providersLoading}
            loadError={providersError}
            disabled={reviewRunning}
            onAdd={addProvider}
            onRemove={removeProvider}
          />
        </div>

        <footer className="modal__foot">
          {tab === 'models' ? (
            <>
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void save()}
                disabled={disabled}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function ProviderSettings({
  providers,
  loading,
  loadError,
  disabled,
  onAdd,
  onRemove,
}: {
  providers: ProviderConnection[];
  loading: boolean;
  loadError?: string;
  disabled: boolean;
  onAdd: (payload: {
    provider: AiProviderId;
    apiKey?: string;
    baseUrl?: string;
    label?: string;
  }) => Promise<ProviderConnection>;
  onRemove: (id: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<AiProviderId>('openai');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string }>();

  const definition = PROVIDER_DEFINITIONS.find((item) => item.id === selected);
  const blocked = busy || disabled;

  const connect = async () => {
    if (!definition || blocked) {
      return;
    }
    const key = definition.requiresKey ? apiKey.trim() : undefined;
    setBusy(true);
    setStatus(undefined);
    try {
      const validation = await api.validateProvider({
        provider: selected,
        apiKey: key,
        baseUrl: baseUrl.trim() || undefined,
      });
      if (!validation.ok) {
        setStatus({ ok: false, message: validation.message });
        return;
      }
      const connection = await onAdd({
        provider: selected,
        apiKey: key,
        baseUrl: baseUrl.trim() || undefined,
        label: label.trim() || undefined,
      });
      setStatus({
        ok: true,
        message: `${connection.label} connected — ${connection.models.length} models available.`,
      });
      setApiKey('');
      setLabel('');
      setBaseUrl('');
    } catch (error) {
      setStatus({ ok: false, message: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (provider: ProviderConnection) => {
    if (blocked || providers.length <= 1) {
      return;
    }
    setBusy(true);
    setStatus(undefined);
    try {
      await onRemove(provider.id);
      setStatus({ ok: true, message: `${provider.label} removed.` });
    } catch (error) {
      setStatus({ ok: false, message: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-settings">
      <section className="provider-settings__section">
        <div className="provider-settings__head">
          <h3>Connected providers</h3>
          <span className="muted">
            {loading
              ? 'Loading…'
              : `${providers.length} connected`}
          </span>
        </div>

        {loadError ? <p className="status status--bad">{loadError}</p> : null}

        {!loading && providers.length === 0 ? (
          <p className="muted">
            No providers are connected. Add one below so reviews and fixes can
            run.
          </p>
        ) : null}

        {providers.length > 0 ? (
          <ul className="connected__list">
            {providers.map((provider) => (
              <li key={provider.id}>
                <span className="dot" />
                <div>
                  <strong>{provider.label}</strong>
                  <small>
                    {providerName(provider.provider)} · {provider.apiKeyMasked} ·{' '}
                    {provider.models.length} model
                    {provider.models.length === 1 ? '' : 's'}
                  </small>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => void remove(provider)}
                  disabled={blocked || providers.length <= 1}
                  title={
                    providers.length <= 1
                      ? 'Keep at least one provider connected'
                      : `Remove ${provider.label}`
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {providers.length === 1 ? (
          <p className="hint">
            Keep at least one provider connected, or add another before
            removing this one.
          </p>
        ) : null}

        {disabled ? (
          <p className="status status--warn">
            A review is running. Provider changes are disabled until it
            finishes.
          </p>
        ) : null}
      </section>

      <section className="provider-settings__section">
        <div className="provider-settings__head">
          <h3>Connect a provider</h3>
        </div>

        <div className="provider-grid provider-grid--compact">
          {PROVIDER_DEFINITIONS.map((provider) => {
            const connected = providers.filter(
              (item) => item.provider === provider.id,
            ).length;
            return (
              <button
                key={provider.id}
                type="button"
                className={`provider-card ${
                  selected === provider.id ? 'is-selected' : ''
                } ${connected > 0 ? 'is-connected' : ''}`}
                onClick={() => {
                  setSelected(provider.id);
                  setStatus(undefined);
                  setBaseUrl('');
                }}
                aria-pressed={selected === provider.id}
              >
                <span className="provider-card__name">{provider.name}</span>
                <span className="provider-card__meta">
                  {connected > 0
                    ? `${connected} connected`
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
                  <a
                    href={definition.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
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

            <div className="provider-settings__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={
                  blocked ||
                  (definition.requiresKey && apiKey.trim().length === 0)
                }
                onClick={() => void connect()}
              >
                {busy ? 'Validating…' : 'Validate & connect'}
              </button>
            </div>

            {status ? (
              <p
                className={`status ${status.ok ? 'status--ok' : 'status--bad'}`}
                role="status"
              >
                {status.message}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
