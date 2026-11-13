import type { ProviderConnection, ReviewJob } from '@org/contracts';
import { dataPath, JsonStore, SecretStore } from '@org/server';

export interface AiState {
  providers: ProviderConnection[];
  selectedProviderId?: string;
  selectedModel?: string;
  hiddenModels: string[];
  jobs: ReviewJob[];
}

export const aiStore = new JsonStore<AiState>(dataPath('ai-svc.json'), {
  providers: [],
  jobs: [],
  hiddenModels: [],
});

export const aiSecrets = new SecretStore(
  dataPath('secrets', 'ai.enc'),
  dataPath('secrets', 'ai.key'),
);
