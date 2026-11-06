import {
  PROVIDER_DEFINITIONS,
  type ModelInfo,
} from '@org/contracts';

interface ModelSwitcherProps {
  models: ModelInfo[];
  selected?: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}

const providerName = (id: string) =>
  PROVIDER_DEFINITIONS.find((provider) => provider.id === id)?.name ?? id;

export function ModelSwitcher({
  models,
  selected,
  onChange,
  disabled,
}: ModelSwitcherProps) {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const list = groups.get(model.provider) ?? [];
    list.push(model);
    groups.set(model.provider, list);
  }

  return (
    <label className={`model-switcher ${disabled ? 'is-disabled' : ''}`}>
      <span className="model-switcher__label">Model</span>
      <select
        value={selected ?? ''}
        disabled={disabled || models.length === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        {models.length === 0 ? <option value="">No models</option> : null}
        {Array.from(groups.entries()).map(([provider, list]) => (
          <optgroup key={provider} label={providerName(provider)}>
            {list.map((model) => (
              <option key={`${model.provider}:${model.id}`} value={model.id}>
                {model.label}
                {model.recommended ? ' ★' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
