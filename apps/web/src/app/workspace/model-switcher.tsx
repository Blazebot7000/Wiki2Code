import {
  PROVIDER_DEFINITIONS,
  modelKey,
  type ModelInfo,
} from '@org/contracts';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

interface ModelSwitcherProps {
  models: ModelInfo[];
  selected?: string;
  selectedProviderId?: string;
  onChange: (model: string, providerId?: string) => void;
  onOpenSettings?: () => void;
  disabled?: boolean;
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

export function ModelSwitcher({
  models,
  selected,
  selectedProviderId,
  onChange,
  onOpenSettings,
  disabled,
}: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: '', at: 0 });
  const idBase = useId().replace(/:/g, '');
  const labelId = `${idBase}-label`;

  const groups = useMemo(() => groupModels(models), [models]);
  const flat = useMemo(
    () => groups.flatMap((group) => group.models),
    [groups],
  );

  const current =
    models.find(
      (model) =>
        model.id === selected && model.connectionId === selectedProviderId,
    ) ??
    models.find((model) => model.id === selected) ??
    models[0];

  const optionId = (index: number) => `${idBase}-option-${index}`;

  useEffect(() => {
    if (!open) {
      return;
    }
    const selectedIndex = flat.findIndex(
      (model) =>
        model.id === current?.id &&
        model.connectionId === current?.connectionId,
    );
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    listRef.current?.focus();
    // Only reset the active row when the menu is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  const choose = (model: ModelInfo) => {
    setOpen(false);
    triggerRef.current?.focus();
    onChange(model.id, model.connectionId);
  };

  const moveActive = (next: number) => {
    if (flat.length === 0) {
      return;
    }
    const bounded = (next + flat.length) % flat.length;
    setActiveIndex(bounded);
    document.getElementById(optionId(bounded))?.scrollIntoView({
      block: 'nearest',
    });
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(activeIndex + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(activeIndex - 1);
        return;
      case 'Home':
        event.preventDefault();
        moveActive(0);
        return;
      case 'End':
        event.preventDefault();
        moveActive(flat.length - 1);
        return;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const model = flat[activeIndex];
        if (model) {
          choose(model);
        }
        return;
      }
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      case 'Tab':
        setOpen(false);
        return;
      default:
        break;
    }

    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const now = Date.now();
      const buffer =
        now - typeahead.current.at > 600
          ? event.key
          : typeahead.current.text + event.key;
      typeahead.current = { text: buffer, at: now };
      const match = flat.findIndex((model) =>
        model.label.toLowerCase().startsWith(buffer.toLowerCase()),
      );
      if (match >= 0) {
        event.preventDefault();
        moveActive(match);
      }
    }
  };

  const openMenu = () => {
    if (disabled || models.length === 0) {
      return;
    }
    setOpen(true);
  };

  return (
    <div className={`model-switcher ${disabled ? 'is-disabled' : ''}`} ref={rootRef}>
      <span className="model-switcher__label" id={labelId}>
        Model
      </span>
      <button
        ref={triggerRef}
        type="button"
        className="model-switcher__trigger"
        disabled={disabled || models.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${idBase}-value`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (
            !open &&
            (event.key === 'ArrowDown' ||
              event.key === 'ArrowUp' ||
              event.key === 'Enter' ||
              event.key === ' ')
          ) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <span className="model-switcher__value" id={`${idBase}-value`}>
          {current ? (
            <>
              <span className="model-switcher__value-label">{current.label}</span>
              {current.free ? <span className="tag tag--free">Free</span> : null}
            </>
          ) : (
            <span className="muted">No models visible</span>
          )}
        </span>
        <span className="model-switcher__chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="model-switcher__popover">
          <div
            ref={listRef}
            className="model-switcher__list"
            role="listbox"
            tabIndex={-1}
            aria-labelledby={labelId}
            aria-activedescendant={
              flat.length > 0 ? optionId(activeIndex) : undefined
            }
            onKeyDown={onListKeyDown}
          >
            {groups.map((group) => {
              const groupAria = group.subheading
                ? `${group.heading}, ${group.subheading}`
                : group.heading;
              return (
                <div
                  key={group.key}
                  role="group"
                  aria-label={groupAria}
                  className="model-switcher__group"
                >
                  <div className="model-switcher__group-head" aria-hidden="true">
                    <span>{group.heading}</span>
                    {group.subheading ? <span>{group.subheading}</span> : null}
                  </div>
                  {group.models.map((model) => {
                    const index = flat.indexOf(model);
                    const isSelected =
                      model.id === current?.id &&
                      model.connectionId === current?.connectionId;
                    return (
                      <div
                        key={modelKey(model)}
                        id={optionId(index)}
                        role="option"
                        aria-selected={isSelected}
                        data-index={index}
                        className={`model-switcher__option ${
                          index === activeIndex ? 'is-active' : ''
                        } ${isSelected ? 'is-selected' : ''}`}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => choose(model)}
                      >
                        <span className="model-switcher__option-label">
                          {model.label}
                        </span>
                        <span className="model-switcher__option-tags">
                          {model.free ? (
                            <span className="tag tag--free">Free</span>
                          ) : null}
                          {model.recommended ? (
                            <span className="tag tag--star">★ Recommended</span>
                          ) : null}
                        </span>
                        <span className="model-switcher__check" aria-hidden="true">
                          {isSelected ? '✓' : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {flat.length === 0 ? (
              <p className="model-switcher__empty">
                Every model is hidden. Use Manage models to show some.
              </p>
            ) : null}
          </div>
          {onOpenSettings ? (
            <div className="model-switcher__foot">
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings();
                }}
              >
                Manage models…
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
