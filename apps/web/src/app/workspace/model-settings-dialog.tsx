import {
  PROVIDER_DEFINITIONS,
  modelKey,
  type ModelInfo,
  type ModelsState,
} from '@org/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';

interface ModelSettingsDialogProps {
  allModels: ModelInfo[];
  hiddenModels: string[];
  onClose: () => void;
  onSaved: (state: ModelsState) => void;
}

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
  onClose,
  onSaved,
}: ModelSettingsDialogProps) {
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(hiddenModels),
  );
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
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
            <h2 id="model-settings-title">Model settings</h2>
            <p className="muted">
              Choose which models appear in the model dropdown. Hiding a model
              does not remove its provider or your API key.
            </p>
          </div>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="Close model settings"
          >
            ×
          </button>
        </header>

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
            <p className="muted model-settings__empty">
              {allModels.length === 0
                ? 'No models are available yet. Connect a provider first.'
                : 'No models match that filter.'}
            </p>
          ) : null}
        </div>

        <footer className="modal__foot">
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
        </footer>
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
