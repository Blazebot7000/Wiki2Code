import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  GITHUB_PATTERNS,
  REVIEW_PATTERNS,
  SYNC_PATTERNS,
  type ConnectedRepo,
  type DeviceFlowPoll,
  type DeviceFlowStart,
  type GithubAccount,
  type RepoSummary,
  type SyncState,
  type WikiPage,
  type WikiPageMeta,
  type WikiUpdateResult,
} from '@org/contracts';
import { sendTo } from '@org/server';
import { Clients } from './clients';
import { gatewayStore } from './gateway.store';

@Controller()
export class GithubController {
  constructor(private readonly clients: Clients) {}

  @Post('github/device/start')
  startDevice(@Body() body: { clientId?: string }): Promise<DeviceFlowStart> {
    return sendTo(this.clients.github, GITHUB_PATTERNS.AUTH_DEVICE_START, {
      clientId: body?.clientId,
    });
  }

  @Post('github/device/poll')
  pollDevice(@Body() body: { sessionId: string }): Promise<DeviceFlowPoll> {
    return sendTo(this.clients.github, GITHUB_PATTERNS.AUTH_DEVICE_POLL, body);
  }

  @Post('github/pat')
  usePat(@Body() body: { token: string }): Promise<GithubAccount> {
    return sendTo(this.clients.github, GITHUB_PATTERNS.AUTH_PAT, body);
  }

  @Get('github/account')
  account(): Promise<GithubAccount | undefined> {
    return sendTo(this.clients.github, GITHUB_PATTERNS.AUTH_ACCOUNT, {});
  }

  @Post('github/logout')
  async logout() {
    // Stop watchers and remove local clones before dropping the token, so the
    // monitoring timers do not keep failing against a repo that no longer
    // exists locally.
    const repos = await sendTo<ConnectedRepo[]>(
      this.clients.github,
      GITHUB_PATTERNS.REPO_LIST,
      {},
    ).catch(() => [] as ConnectedRepo[]);
    await Promise.allSettled(
      repos.map((repo) =>
        sendTo(this.clients.sync, SYNC_PATTERNS.WATCH_STOP, {
          repoId: repo.repoId,
        }),
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
      repos.map((repo) =>
        sendTo(this.clients.review, REVIEW_PATTERNS.HIGHLIGHTS_CLEAR_REPO, {
          repoId: repo.repoId,
        }),
      ),
    );
    const result = await sendTo(this.clients.github, GITHUB_PATTERNS.AUTH_LOGOUT, {});
    gatewayStore.update((state) => ({ ...state, activeRepoId: undefined }));
    return result;
  }

  @Get('github/repos')
  listRemote(): Promise<RepoSummary[]> {
    return sendTo(this.clients.github, GITHUB_PATTERNS.REPOS_LIST_REMOTE, {});
  }

  @Get('repos')
  list(): Promise<ConnectedRepo[]> {
    return sendTo(this.clients.github, GITHUB_PATTERNS.REPO_LIST, {});
  }

  @Post('repos')
  async connect(
    @Body() body: { owner: string; name: string },
  ): Promise<ConnectedRepo> {
    if (!body?.owner || !body?.name) {
      throw new BadRequestException('owner and name are required.');
    }
    const repo = await sendTo<ConnectedRepo>(
      this.clients.github,
      GITHUB_PATTERNS.REPO_CONNECT,
      body,
    );
    gatewayStore.update((state) => ({
      ...state,
      activeRepoId: repo.repoId,
    }));
    await sendTo(this.clients.sync, SYNC_PATTERNS.WATCH_START, {
      repoId: repo.repoId,
      immediate: false,
    });
    return repo;
  }

  @Get('repos/:repoId')
  get(@Param('repoId') repoId: string): Promise<ConnectedRepo> {
    return sendTo(this.clients.github, GITHUB_PATTERNS.REPO_GET, { repoId });
  }

  @Delete('repos/:repoId')
  async disconnect(@Param('repoId') repoId: string) {
    await sendTo(this.clients.sync, SYNC_PATTERNS.WATCH_STOP, { repoId });
    const result = await sendTo(
      this.clients.github,
      GITHUB_PATTERNS.REPO_DISCONNECT,
      { repoId },
    );
    // Drop findings for the removed repository so reconnecting it later starts
    // from a clean slate instead of showing highlights for a stale clone.
    await sendTo(
      this.clients.review,
      REVIEW_PATTERNS.HIGHLIGHTS_CLEAR_REPO,
      { repoId },
    ).catch(() => undefined);
    const state = gatewayStore.read();
    if (state.activeRepoId === repoId) {
      gatewayStore.update((current) => ({ ...current, activeRepoId: undefined }));
    }
    return result;
  }

  @Post('repos/:repoId/activate')
  activate(@Param('repoId') repoId: string) {
    gatewayStore.update((state) => ({ ...state, activeRepoId: repoId }));
    return { ok: true, activeRepoId: repoId };
  }

  @Post('repos/:repoId/sync')
  sync(@Param('repoId') repoId: string): Promise<ConnectedRepo> {
    return sendTo(this.clients.github, GITHUB_PATTERNS.REPO_SYNC, { repoId });
  }

  @Get('repos/:repoId/wiki')
  listWiki(@Param('repoId') repoId: string): Promise<WikiPageMeta[]> {
    return sendTo(this.clients.github, GITHUB_PATTERNS.WIKI_LIST, { repoId });
  }

  @Get('repos/:repoId/wiki/page')
  getWiki(
    @Param('repoId') repoId: string,
    @Query('slug') slug: string,
  ): Promise<WikiPage> {
    if (!slug) {
      throw new BadRequestException('slug is required.');
    }
    return sendTo(this.clients.github, GITHUB_PATTERNS.WIKI_GET, {
      repoId,
      slug,
    });
  }

  @Put('repos/:repoId/wiki/page')
  updateWiki(
    @Param('repoId') repoId: string,
    @Body() body: { slug: string; markdown: string; message?: string },
  ): Promise<WikiUpdateResult> {
    return sendTo(this.clients.github, GITHUB_PATTERNS.WIKI_UPDATE, {
      repoId,
      pageSlug: body.slug,
      markdown: body.markdown,
      message: body.message,
    });
  }

  @Get('repos/:repoId/code/tree')
  codeTree(@Param('repoId') repoId: string): Promise<string[]> {
    return sendTo(this.clients.github, GITHUB_PATTERNS.CODE_TREE, { repoId });
  }

  @Get('repos/:repoId/code/file')
  readCode(
    @Param('repoId') repoId: string,
    @Query('path') path: string,
  ): Promise<{ path: string; content: string }> {
    if (!path) {
      throw new BadRequestException('path is required.');
    }
    return sendTo(this.clients.github, GITHUB_PATTERNS.CODE_READ, {
      repoId,
      path,
    });
  }

  @Get('repos/:repoId/code/search')
  searchCode(
    @Param('repoId') repoId: string,
    @Query('q') query: string,
  ): Promise<{ path: string; line: number; text: string }[]> {
    const terms = (query ?? '')
      .split(/[\s,]+/)
      .map((term) => term.trim())
      .filter(Boolean);
    return sendTo(this.clients.github, GITHUB_PATTERNS.CODE_SEARCH, {
      repoId,
      terms,
    });
  }

  @Get('repos/:repoId/sync-state')
  syncState(@Param('repoId') repoId: string): Promise<SyncState> {
    return sendTo(this.clients.sync, SYNC_PATTERNS.STATE, { repoId });
  }

  @Post('repos/:repoId/watch')
  startWatch(
    @Param('repoId') repoId: string,
    @Body() body: { intervalMs?: number },
  ): Promise<SyncState> {
    return sendTo(this.clients.sync, SYNC_PATTERNS.WATCH_START, {
      repoId,
      intervalMs: body?.intervalMs,
    });
  }

  @Delete('repos/:repoId/watch')
  stopWatch(@Param('repoId') repoId: string): Promise<SyncState> {
    return sendTo(this.clients.sync, SYNC_PATTERNS.WATCH_STOP, { repoId });
  }

  @Post('repos/:repoId/sync-now')
  syncNow(@Param('repoId') repoId: string): Promise<SyncState> {
    return sendTo(this.clients.sync, SYNC_PATTERNS.TICK, { repoId });
  }
}
