import { Injectable, Logger } from '@nestjs/common';
import {
  PROVIDER_DEFINITIONS,
  type AiProviderId,
  type ModelInfo,
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
      const selectedStillExists = providers.some(
        (item) => item.id === state.selectedProviderId,
      );
      return {
        ...state,
        providers,
        selectedProviderId: selectedStillExists
          ? state.selectedProviderId
          : providers[0]?.id,
        selectedModel: providers.some((item) =>
          item.models.some((model) => model.id === state.selectedModel),
        )
          ? state.selectedModel
          : providers[0]?.models[0]?.id,
      };
    });
    return { ok: true };
  }

  select(payload: { model: string; providerId?: string }): {
    selectedModel?: string;
    selectedProviderId?: string;
  } {
    const state = aiStore.read();
    const connection =
      state.providers.find((item) => item.id === payload.providerId) ??
      state.providers.find((item) =>
        item.models.some((model) => model.id === payload.model),
      );
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

  models(): ModelInfo[] {
    return aiStore
      .read()
      .providers.flatMap((provider) => provider.models);
  }

  selection(): { selectedModel?: string; selectedProviderId?: string } {
    const state = aiStore.read();
    return {
      selectedModel: this.selectedModel(),
      selectedProviderId:
        state.selectedProviderId ?? state.providers[0]?.id,
    };
  }

  selectedModel(): string | undefined {
    const state = aiStore.read();
    if (state.selectedModel) {
      return state.selectedModel;
    }
    return state.providers[0]?.models[0]?.id;
  }

  resolve(model: string): ModelTarget {
    const state = aiStore.read();
    const connection =
      state.providers.find((item) =>
        item.models.some((candidate) => candidate.id === model),
      ) ??
      state.providers.find((item) => item.id === state.selectedProviderId);
    if (!connection) {
      throw new Error('No AI provider is connected. Add one in setup.');
    }
    const resolvedModel = connection.models.some((item) => item.id === model)
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
}
