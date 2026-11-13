import { Injectable, Logger } from '@nestjs/common';
import {
  PROVIDER_DEFINITIONS,
  modelKey,
  type AiProviderId,
  type ModelInfo,
  type ModelsState,
  type ProviderConnection,
  type ProviderValidationResult,
} from '@org/contracts';
import { maskSecret, newId } from '@org/server';
import { aiSecrets, aiStore } from './ai.store';
import { chat, validateProvider, type ChatMessage } from './providers';

export interface ModelTarget {
  connection: ProviderConnection;
  apiKey?: string;
  model: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  listProviders(): ProviderConnection[] {
    return aiStore.read().providers;
  }

  async validate(payload: {
    provider: AiProviderId;
    apiKey?: string;
    baseUrl?: string;
  }): Promise<ProviderValidationResult> {
    return validateProvider(payload);
  }

  async add(payload: {
    provider: AiProviderId;
    apiKey?: string;
    baseUrl?: string;
    label?: string;
  }): Promise<ProviderConnection> {
    const definition = PROVIDER_DEFINITIONS.find(
      (item) => item.id === payload.provider,
    );
    if (!definition) {
      throw new Error(`Unknown provider: ${payload.provider}`);
    }
    const result = await this.validate(payload);
    if (!result.ok) {
      throw new Error(result.message);
    }

    const connection: ProviderConnection = {
      id: newId('prov'),
      provider: payload.provider,
      label:
        payload.label?.trim() ||
        result.accountLabel ||
        definition.name,
      apiKeyMasked: payload.apiKey ? maskSecret(payload.apiKey) : 'local',
      baseUrl: payload.baseUrl?.trim() || undefined,
      status: 'connected',
      models: result.models,
      createdAt: new Date().toISOString(),
    };

    if (payload.apiKey) {
      aiSecrets.set(connection.id, payload.apiKey.trim());
    }

    aiStore.update((state) => {
      const providers = [...state.providers, connection];
      const selectedModel =
        state.selectedModel ??
        result.models.find((model) => model.recommended)?.id ??
        result.models[0]?.id;
      return {
        ...state,
        providers,
        selectedProviderId: state.selectedProviderId ?? connection.id,
        selectedModel,
      };
    });

    return connection;
  }

  remove(id: string): { ok: true } {
    aiSecrets.remove(id);
    aiStore.update((state) => {
      const providers = state.providers.filter((item) => item.id !== id);
      const hiddenModels = (state.hiddenModels ?? []).filter(
        (key) => !key.startsWith(`${id}::`),
      );
      const hidden = new Set(hiddenModels);
      const visible = providers
        .flatMap((connection) => this.serialize(connection))
        .filter((model) => !hidden.has(modelKey(model)));
      return {
        ...state,
        providers,
        hiddenModels,
        ...this.pickSelection(
          state.selectedModel,
          state.selectedProviderId,
          visible,
        ),
      };
    });
    return { ok: true };
  }

  select(payload: { model: string; providerId?: string }): {
    selectedModel?: string;
    selectedProviderId?: string;
  } {
    const state = aiStore.read();
    const offered = (connection: ProviderConnection) =>
      connection.models.some((model) => model.id === payload.model);
    const connection =
      (payload.providerId
        ? state.providers.find(
            (item) => item.id === payload.providerId && offered(item),
          )
        : undefined) ??
      state.providers.find(
        (item) =>
          item.id === state.selectedProviderId && offered(item),
      ) ??
      state.providers.find(offered);
    if (!connection) {
      throw new Error('That model is not offered by a connected provider.');
    }
    aiStore.update((current) => ({
      ...current,
      selectedModel: payload.model,
      selectedProviderId: connection.id,
    }));
    return {
      selectedModel: payload.model,
      selectedProviderId: connection.id,
    };
  }

  modelsState(): ModelsState {
    const state = aiStore.read();
    const allModels = this.allModels();
    const hiddenModels = state.hiddenModels ?? [];
    const hidden = new Set(hiddenModels);
    const models = allModels.filter((model) => !hidden.has(modelKey(model)));
    return {
      models,
      allModels,
      hiddenModels,
      ...this.pickSelection(
        state.selectedModel,
        state.selectedProviderId,
        models,
      ),
    };
  }

  setModelVisibility(payload: { hiddenModels: string[] }): ModelsState {
    const available = this.allModels();
    const availableKeys = new Set(available.map(modelKey));
    const hiddenModels = Array.from(
      new Set(
        (payload.hiddenModels ?? []).filter((key) => availableKeys.has(key)),
      ),
    );
    if (available.length > 0 && hiddenModels.length >= available.length) {
      throw new Error(
        'Keep at least one model visible so reviews and fixes can run.',
      );
    }
    const hidden = new Set(hiddenModels);
    const visible = available.filter(
      (model) => !hidden.has(modelKey(model)),
    );
    aiStore.update((state) => ({
      ...state,
      hiddenModels,
      ...this.pickSelection(
        state.selectedModel,
        state.selectedProviderId,
        visible,
      ),
    }));
    return this.modelsState();
  }

  selection(): { selectedModel?: string; selectedProviderId?: string } {
    const state = aiStore.read();
    const allModels = this.allModels();
    const hidden = new Set(state.hiddenModels ?? []);
    const visible = allModels.filter(
      (model) => !hidden.has(modelKey(model)),
    );
    return this.pickSelection(
      state.selectedModel,
      state.selectedProviderId,
      visible,
    );
  }

  selectedModel(): string | undefined {
    return this.selection().selectedModel;
  }

  resolve(model: string, providerId?: string): ModelTarget {
    const state = aiStore.read();
    if (state.providers.length === 0) {
      throw new Error('No AI provider is connected. Add one in setup.');
    }
    const hasModel = (connection: ProviderConnection) =>
      connection.models.some((candidate) => candidate.id === model);

    const explicit = providerId
      ? state.providers.find((item) => item.id === providerId)
      : undefined;
    if (providerId && !explicit) {
      throw new Error('That provider is no longer connected.');
    }

    // Prefer the provider the user picked for this model id. The same id can
    // be offered by several providers, and routing to the wrong one used to
    // make the selected provider appear to be ignored.
    const connection =
      (explicit && hasModel(explicit) ? explicit : undefined) ??
      state.providers.find(
        (item) => item.id === state.selectedProviderId && hasModel(item),
      ) ??
      state.providers.find(hasModel) ??
      explicit ??
      state.providers.find((item) => item.id === state.selectedProviderId) ??
      state.providers[0];

    const resolvedModel = hasModel(connection)
      ? model
      : connection.models[0]?.id;
    if (!resolvedModel) {
      throw new Error(`Provider ${connection.label} has no models available.`);
    }
    return {
      connection,
      apiKey: aiSecrets.get<string>(connection.id),
      model: resolvedModel,
    };
  }

  async chatWithModel(
    model: string,
    messages: ChatMessage[],
    options: { json?: boolean; maxTokens?: number; temperature?: number } = {},
  ): Promise<string> {
    const target = this.resolve(model);
    try {
      return await chat({
        provider: target.connection.provider,
        apiKey: target.apiKey,
        baseUrl: target.connection.baseUrl,
        model: target.model,
        messages,
        json: options.json,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
      });
    } catch (error) {
      this.logger.warn(
        `Chat failed with ${target.connection.provider}/${target.model}: ${String(error)}`,
      );
      throw error;
    }
  }

  private allModels(): ModelInfo[] {
    return aiStore
      .read()
      .providers.flatMap((connection) => this.serialize(connection));
  }

  /**
   * Persisted connections can predate `connectionId`/`free`, so always derive
   * the display fields. The connection id is required to tell identical model
   * ids from different providers apart.
   */
  private serialize(connection: ProviderConnection): ModelInfo[] {
    const definition = PROVIDER_DEFINITIONS.find(
      (item) => item.id === connection.provider,
    );
    return connection.models.map((model) => ({
      ...model,
      connectionId: connection.id,
      providerLabel: connection.label || definition?.name || connection.provider,
      free:
        model.free ??
        (connection.provider === 'ollama' || /:free$/i.test(model.id)),
    }));
  }

  private pickSelection(
    currentModel: string | undefined,
    currentProviderId: string | undefined,
    visible: ModelInfo[],
  ): { selectedModel?: string; selectedProviderId?: string } {
    const exact =
      visible.find(
        (model) =>
          model.id === currentModel &&
          model.connectionId === currentProviderId,
      ) ??
      visible.find((model) => model.id === currentModel);
    const chosen =
      exact ??
      visible.find((model) => model.recommended) ??
      visible[0];
    if (!chosen) {
      return { selectedModel: undefined, selectedProviderId: undefined };
    }
    return {
      selectedModel: chosen.id,
      selectedProviderId: chosen.connectionId,
    };
  }
}
