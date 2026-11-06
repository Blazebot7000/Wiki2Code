import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import {
  AI_PATTERNS,
  GITHUB_PATTERNS,
  SYNC_PATTERNS,
  type AiProviderId,
  type ConnectedRepo,
  type GithubAccount,
  type ModelInfo,
  type ProviderConnection,
  type ProviderValidationResult,
  type SetupState,
  type SyncState,
} from '@org/contracts';
import { sendTo } from '@org/server';
import { Clients } from './clients';
import { gatewayStore } from './gateway.store';

@Controller()
export class SetupController {
  constructor(private readonly clients: Clients) {}

  @Get('setup')
  async setup(): Promise<SetupState> {
    const [providers, models, account, repos] = await Promise.all([
      sendTo<ProviderConnection[]>(
        this.clients.ai,
        AI_PATTERNS.PROVIDERS_LIST,
        {},
      ),
      sendTo<{
        models: ModelInfo[];
        selectedModel?: string;
        selectedProviderId?: string;
      }>(this.clients.ai, AI_PATTERNS.MODELS_LIST, {}),
      sendTo<GithubAccount | undefined>(
        this.clients.github,
        GITHUB_PATTERNS.AUTH_ACCOUNT,
        {},
      ),
      sendTo<ConnectedRepo[]>(this.clients.github, GITHUB_PATTERNS.REPO_LIST, {}),
    ]);

    const state = gatewayStore.read();
    return {
      providers,
      selectedProviderId: models.selectedProviderId,
      selectedModel: models.selectedModel,
      github: account ?? undefined,
      repos,
      activeRepoId: state.activeRepoId ?? repos[0]?.repoId,
      completed: state.completed,
    };
  }

  @Post('setup/complete')
  async complete(): Promise<SetupState> {
    const state = await this.setup();
    if (state.providers.length === 0) {
      throw new BadRequestException('Connect at least one AI provider first.');
    }
    if (!state.github) {
      throw new BadRequestException('Sign in to GitHub first.');
    }
    if (state.repos.length === 0) {
      throw new BadRequestException('Connect a repository first.');
    }
    gatewayStore.update((current) => ({
      ...current,
      completed: true,
      activeRepoId: current.activeRepoId ?? state.repos[0]?.repoId,
    }));
    return this.setup();
  }

  @Post('setup/reset')
  async reset(): Promise<SetupState> {
    const [repos, providers] = await Promise.all([
      sendTo<ConnectedRepo[]>(this.clients.github, GITHUB_PATTERNS.REPO_LIST, {}),
      sendTo<ProviderConnection[]>(
        this.clients.ai,
        AI_PATTERNS.PROVIDERS_LIST,
        {},
      ),
    ]);

    await Promise.allSettled(
      repos.map((repo) =>
        sendTo(this.clients.sync, SYNC_PATTERNS.WATCH_STOP, { repoId: repo.repoId }),
      ),
    );
    await Promise.allSettled(
      repos.map((repo) =>
        sendTo(this.clients.github, GITHUB_PATTERNS.REPO_DISCONNECT, {
          repoId: repo.repoId,
        }),
      ),
    );
    await Promise.allSettled(
      providers.map((provider) =>
        sendTo(this.clients.ai, AI_PATTERNS.PROVIDERS_REMOVE, {
          id: provider.id,
        }),
      ),
    );
    await sendTo(this.clients.github, GITHUB_PATTERNS.AUTH_LOGOUT, {});

    gatewayStore.write({ completed: false });
    return this.setup();
  }

  @Get('providers')
  listProviders(): Promise<ProviderConnection[]> {
    return sendTo(this.clients.ai, AI_PATTERNS.PROVIDERS_LIST, {});
  }

  @Post('providers/validate')
  validate(
    @Body() body: { provider: AiProviderId; apiKey?: string; baseUrl?: string },
  ): Promise<ProviderValidationResult> {
    return sendTo(this.clients.ai, AI_PATTERNS.PROVIDERS_VALIDATE, body);
  }

  @Post('providers')
  add(
    @Body()
    body: {
      provider: AiProviderId;
      apiKey?: string;
      baseUrl?: string;
      label?: string;
    },
  ): Promise<ProviderConnection> {
    return sendTo(this.clients.ai, AI_PATTERNS.PROVIDERS_ADD, body);
  }

  @Delete('providers/:id')
  remove(@Param('id') id: string) {
    return sendTo(this.clients.ai, AI_PATTERNS.PROVIDERS_REMOVE, { id });
  }

  @Post('providers/select')
  select(@Body() body: { model: string; providerId?: string }) {
    return sendTo(this.clients.ai, AI_PATTERNS.PROVIDERS_SELECT, body);
  }

  @Get('models')
  models(): Promise<{
    models: ModelInfo[];
    selectedModel?: string;
    selectedProviderId?: string;
  }> {
    return sendTo(this.clients.ai, AI_PATTERNS.MODELS_LIST, {});
  }

  @Get('sync-state')
  async syncStates(): Promise<SyncState[]> {
    return sendTo<SyncState[]>(this.clients.sync, SYNC_PATTERNS.WATCH_LIST, {});
  }
}
