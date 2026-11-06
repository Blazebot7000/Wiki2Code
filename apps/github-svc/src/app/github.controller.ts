import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { GITHUB_PATTERNS, type DevPlan } from '@org/contracts';
import { DevCycleService } from './devcycle.service';
import { GithubAuthService } from './github-auth.service';
import { GithubReposService } from './github-repos.service';

@Controller()
export class GithubController {
  constructor(
    private readonly auth: GithubAuthService,
    private readonly repos: GithubReposService,
    private readonly devcycle: DevCycleService,
  ) {}

  @MessagePattern(GITHUB_PATTERNS.AUTH_DEVICE_START)
  startDevice(payload: { clientId?: string }) {
    return this.auth.startDevice(payload ?? {});
  }

  @MessagePattern(GITHUB_PATTERNS.AUTH_DEVICE_POLL)
  pollDevice(payload: { sessionId: string }) {
    return this.auth.pollDevice(payload);
  }

  @MessagePattern(GITHUB_PATTERNS.AUTH_PAT)
  usePat(payload: { token: string }) {
    return this.auth.usePat(payload);
  }

  @MessagePattern(GITHUB_PATTERNS.AUTH_ACCOUNT)
  async account() {
    return (await this.auth.account()) ?? null;
  }

  @MessagePattern(GITHUB_PATTERNS.AUTH_LOGOUT)
  logout() {
    this.auth.logout();
    return { ok: true };
  }

  @MessagePattern(GITHUB_PATTERNS.REPOS_LIST_REMOTE)
  listRemote() {
    return this.repos.listRemote();
  }

  @MessagePattern(GITHUB_PATTERNS.REPO_CONNECT)
  connect(payload: { owner: string; name: string }) {
    return this.repos.connect(payload);
  }

  @MessagePattern(GITHUB_PATTERNS.REPO_DISCONNECT)
  disconnect(payload: { repoId: string }) {
    return this.repos.disconnect(payload.repoId);
  }

  @MessagePattern(GITHUB_PATTERNS.REPO_LIST)
  list() {
    return this.repos.list();
  }

  @MessagePattern(GITHUB_PATTERNS.REPO_GET)
  get(payload: { repoId: string }) {
    return this.repos.get(payload.repoId);
  }

  @MessagePattern(GITHUB_PATTERNS.REPO_SYNC)
  sync(payload: { repoId: string }) {
    return this.repos.sync(payload.repoId);
  }

  @MessagePattern(GITHUB_PATTERNS.REPO_POLL)
  poll(payload: { repoId: string }) {
    return this.repos.poll(payload.repoId);
  }

  @MessagePattern(GITHUB_PATTERNS.WIKI_LIST)
  listWiki(payload: { repoId: string }) {
    return this.repos.listWiki(payload.repoId);
  }

  @MessagePattern(GITHUB_PATTERNS.WIKI_GET)
  getWiki(payload: { repoId: string; slug: string }) {
    return this.repos.getWiki(payload.repoId, payload.slug);
  }

  @MessagePattern(GITHUB_PATTERNS.WIKI_UPDATE)
  updateWiki(payload: {
    repoId: string;
    pageSlug: string;
    markdown: string;
    message?: string;
  }) {
    return this.repos.updateWiki(payload);
  }

  @MessagePattern(GITHUB_PATTERNS.CODE_TREE)
  codeTree(payload: { repoId: string }) {
    return this.repos.codeTree(payload.repoId);
  }

  @MessagePattern(GITHUB_PATTERNS.CODE_READ)
  readCode(payload: { repoId: string; path: string }) {
    return this.repos.readCode(payload);
  }

  @MessagePattern(GITHUB_PATTERNS.CODE_SEARCH)
  searchCode(payload: { repoId: string; terms: string[]; maxFiles?: number }) {
    return this.repos.searchCode(payload);
  }

  @MessagePattern(GITHUB_PATTERNS.DEVCYCLE_EXECUTE)
  execute(payload: {
    repoId: string;
    highlightId: string;
    plan: DevPlan;
    dryRun?: boolean;
    merge?: boolean;
  }) {
    return this.devcycle.start(payload);
  }

  @MessagePattern(GITHUB_PATTERNS.DEVCYCLE_GET)
  getJob(payload: { jobId: string }) {
    return this.devcycle.get(payload.jobId) ?? null;
  }

  @MessagePattern(GITHUB_PATTERNS.DEVCYCLE_LIST)
  listJobs(payload: { repoId: string }) {
    return this.devcycle.list(payload.repoId);
  }
}
