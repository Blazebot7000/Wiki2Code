import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import type {
  ConnectedRepo,
  RepoSummary,
  WikiPage,
  WikiPageMeta,
  WikiUpdateResult,
} from '@org/contracts';
import {
  changedFiles,
  cloneRepo,
  commitAll,
  currentSha,
  defaultBranchOf,
  fetchAndReset,
  isWikiMarkdown,
  listFiles,
  pagePath,
  pageSlug,
  pageTitle,
  pushBranch,
  remoteSha,
  remoteUrl,
  repoPath,
  safeRepoId,
  sortPages,
} from '@org/server';
import { GithubAuthService } from './github-auth.service';
import { githubStore } from './github.store';

const WIKI_BRANCH_FALLBACK = 'master';
const MAX_FILE_BYTES = 200 * 1024;

export interface PollResult {
  codeChanged: boolean;
  wikiChanged: boolean;
  codeSha?: string;
  wikiSha?: string;
  changedPaths: string[];
}

@Injectable()
export class GithubReposService {
  private readonly logger = new Logger(GithubReposService.name);

  constructor(private readonly auth: GithubAuthService) {}

  async listRemote(): Promise<RepoSummary[]> {
    return this.auth.client().listRepos();
  }

  list(): ConnectedRepo[] {
    return githubStore.read().repos;
  }

  get(repoId: string): ConnectedRepo {
    const repo = githubStore.read().repos.find((item) => item.repoId === repoId);
    if (!repo) {
      throw new Error(`Repository ${repoId} is not connected.`);
    }
    return repo;
  }

  async connect(payload: {
    owner: string;
    name: string;
  }): Promise<ConnectedRepo> {
    const token = this.auth.requireToken();
    const client = this.auth.client();
    const summary = await client.getRepo(payload.owner, payload.name);

    if (!summary.hasWiki) {
      await client.enableWiki(payload.owner, payload.name);
      summary.hasWiki = true;
    }

    const repoId = safeRepoId(payload.owner, payload.name);
    const codeDir = repoPath(repoId, 'code');
    const wikiDir = repoPath(repoId, 'wiki');

    let codeReady = false;
    let codeError: string | undefined;
    try {
      if (!existsSync(join(codeDir, '.git'))) {
        await cloneRepo(
          codeDir,
          remoteUrl(payload.owner, payload.name, token),
          summary.defaultBranch,
        );
      } else {
        await fetchAndReset(codeDir, summary.defaultBranch);
      }
      codeReady = true;
    } catch (error) {
      codeError = this.describe(error);
      this.logger.warn(`Code clone failed for ${repoId}: ${codeError}`);
    }

    let wikiReady = false;
    let wikiError: string | undefined;
    try {
      if (!existsSync(join(wikiDir, '.git'))) {
        await cloneRepo(wikiDir, remoteUrl(payload.owner, payload.name, token, true));
      } else {
        await fetchAndReset(wikiDir, await this.wikiBranch(wikiDir));
      }
      wikiReady = true;
    } catch (error) {
      wikiError =
        `The wiki has no pages yet. Create the first page at ` +
        `${summary.htmlUrl}/wiki/_new, then press Sync.`;
      this.logger.warn(`Wiki clone failed for ${repoId}: ${this.describe(error)}`);
    }

    const repo: ConnectedRepo = {
      ...summary,
      repoId,
      wikiReady,
      codeReady,
      wikiError: wikiError ?? (codeError ? `Code clone failed: ${codeError}` : undefined),
      lastCodeSha: codeReady ? await this.shaOrUndefined(codeDir) : undefined,
      lastWikiSha: wikiReady ? await this.shaOrUndefined(wikiDir) : undefined,
      lastSyncedAt: new Date().toISOString(),
      wikiPageCount: wikiReady ? (await this.readWikiPages(repoId)).length : 0,
      addedAt: new Date().toISOString(),
    };

    githubStore.update((state) => {
      const others = state.repos.filter((item) => item.repoId !== repoId);
      return { ...state, repos: [...others, repo] };
    });

    return repo;
  }

  disconnect(repoId: string): { ok: true } {
    const repo = githubStore.read().repos.find((item) => item.repoId === repoId);
    githubStore.update((state) => ({
      ...state,
      repos: state.repos.filter((item) => item.repoId !== repoId),
    }));
    if (repo) {
      for (const kind of ['code', 'wiki'] as const) {
        rmSync(repoPath(repoId, kind), { recursive: true, force: true });
      }
    }
    return { ok: true };
  }

  async sync(repoId: string): Promise<ConnectedRepo> {
    const repo = this.get(repoId);
    const codeDir = repoPath(repoId, 'code');
    const wikiDir = repoPath(repoId, 'wiki');
    let wikiError: string | undefined;

    if (existsSync(join(codeDir, '.git'))) {
      await fetchAndReset(codeDir, repo.defaultBranch);
    }
    if (existsSync(join(wikiDir, '.git'))) {
      await fetchAndReset(wikiDir, await this.wikiBranch(wikiDir));
    } else {
      try {
        await cloneRepo(
          wikiDir,
          remoteUrl(repo.owner, repo.name, this.auth.requireToken(), true),
        );
      } catch (error) {
        wikiError = this.describe(error);
      }
    }

    const updated: ConnectedRepo = {
      ...repo,
      codeReady: existsSync(join(codeDir, '.git')),
      wikiReady: existsSync(join(wikiDir, '.git')),
      wikiError,
      lastCodeSha: await this.shaOrUndefined(codeDir),
      lastWikiSha: await this.shaOrUndefined(wikiDir),
      lastSyncedAt: new Date().toISOString(),
      wikiPageCount: existsSync(join(wikiDir, '.git'))
        ? (await this.readWikiPages(repoId)).length
        : 0,
    };

    githubStore.update((state) => ({
      ...state,
      repos: state.repos.map((item) =>
        item.repoId === repoId ? updated : item,
      ),
    }));
    return updated;
  }

  async poll(repoId: string): Promise<PollResult> {
    const repo = this.get(repoId);
    const codeDir = repoPath(repoId, 'code');
    const wikiDir = repoPath(repoId, 'wiki');
    const changedPaths: string[] = [];

    let codeSha = repo.lastCodeSha;
    let wikiSha = repo.lastWikiSha;
    let codeChanged = false;
    let wikiChanged = false;

    if (existsSync(join(codeDir, '.git'))) {
      const remote = await remoteSha(codeDir, repo.defaultBranch);
      if (remote && remote !== repo.lastCodeSha) {
        const previous = repo.lastCodeSha;
        await fetchAndReset(codeDir, repo.defaultBranch);
        codeSha = await currentSha(codeDir);
        codeChanged = true;
        if (previous) {
          changedPaths.push(...(await changedFiles(codeDir, previous, codeSha)));
        }
      }
    }

    if (existsSync(join(wikiDir, '.git'))) {
      const branch = await this.wikiBranch(wikiDir);
      const remote = await remoteSha(wikiDir, branch);
      if (remote && remote !== repo.lastWikiSha) {
        await fetchAndReset(wikiDir, branch);
        wikiSha = await currentSha(wikiDir);
        wikiChanged = true;
      }
    }

    if (codeChanged || wikiChanged) {
      githubStore.update((state) => ({
        ...state,
        repos: state.repos.map((item) =>
          item.repoId === repoId
            ? {
                ...item,
                lastCodeSha: codeSha,
                lastWikiSha: wikiSha,
                lastSyncedAt: new Date().toISOString(),
                wikiPageCount: existsSync(join(wikiDir, '.git'))
                  ? item.wikiPageCount
                  : 0,
              }
            : item,
        ),
      }));
    }

    return { codeChanged, wikiChanged, codeSha, wikiSha, changedPaths };
  }

  async listWiki(repoId: string): Promise<WikiPageMeta[]> {
    this.get(repoId);
    return this.readWikiPages(repoId);
  }

  private async readWikiPages(repoId: string): Promise<WikiPageMeta[]> {
    const wikiDir = repoPath(repoId, 'wiki');
    if (!existsSync(join(wikiDir, '.git'))) {
      return [];
    }
    const files = await this.walk(wikiDir);
    const pages: WikiPageMeta[] = [];
    for (const absolute of files) {
      const path = this.toRepoPath(wikiDir, absolute);
      if (!isWikiMarkdown(path)) {
        continue;
      }
      const markdown = readFileSync(absolute, 'utf8');
      const slug = pageSlug(path);
      pages.push({
        slug,
        path,
        title: pageTitle(markdown, slug.split('/').pop() ?? slug),
        order: pages.length,
      });
    }
    return sortPages(pages).map((page, index) => ({ ...page, order: index }));
  }

  async getWiki(repoId: string, slug: string): Promise<WikiPage> {
    const wikiDir = repoPath(repoId, 'wiki');
    const path = this.safeJoin(wikiDir, pagePath(slug));
    if (!existsSync(path)) {
      throw new Error(`Wiki page "${slug}" does not exist.`);
    }
    const markdown = readFileSync(path, 'utf8');
    const meta = (await this.listWiki(repoId)).find((page) => page.slug === slug);
    return {
      slug,
      path: meta?.path ?? pagePath(slug),
      title: meta?.title ?? slug,
      order: meta?.order ?? 0,
      markdown,
    };
  }

  async updateWiki(payload: {
    repoId: string;
    pageSlug: string;
    markdown: string;
    message?: string;
  }): Promise<WikiUpdateResult> {
    const repo = this.get(payload.repoId);
    const wikiDir = repoPath(payload.repoId, 'wiki');
    if (!existsSync(join(wikiDir, '.git'))) {
      throw new Error(
        repo.wikiError ??
          'The wiki is not available locally. Create the first page on GitHub and sync.',
      );
    }
    const path = this.safeJoin(wikiDir, pagePath(payload.pageSlug));
    writeFileSync(path, payload.markdown, 'utf8');

    const sha = await commitAll(
      wikiDir,
      payload.message ?? `docs: update ${payload.pageSlug}`,
      'Wiki2Code',
      'wiki2code@users.noreply.github.com',
    );
    await pushBranch(wikiDir, await this.wikiBranch(wikiDir));

    githubStore.update((state) => ({
      ...state,
      repos: state.repos.map((item) =>
        item.repoId === payload.repoId
          ? {
              ...item,
              lastWikiSha: sha,
              lastSyncedAt: new Date().toISOString(),
            }
          : item,
      ),
    }));

    return { pageSlug: payload.pageSlug, commitSha: sha, markdown: payload.markdown };
  }

  async codeTree(repoId: string): Promise<string[]> {
    const dir = repoPath(repoId, 'code');
    if (!existsSync(join(dir, '.git'))) {
      return [];
    }
    return listFiles(dir, 600);
  }

  async readCode(payload: {
    repoId: string;
    path: string;
  }): Promise<{ path: string; content: string }> {
    const dir = repoPath(payload.repoId, 'code');
    const absolute = this.safeJoin(dir, payload.path);
    if (!existsSync(absolute)) {
      throw new Error(`File not found: ${payload.path}`);
    }
    const info = statSync(absolute);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large to read: ${payload.path}`);
    }
    return { path: payload.path, content: readFileSync(absolute, 'utf8') };
  }

  async searchCode(payload: {
    repoId: string;
    terms: string[];
    maxFiles?: number;
  }): Promise<{ path: string; line: number; text: string }[]> {
    const dir = repoPath(payload.repoId, 'code');
    if (!existsSync(join(dir, '.git'))) {
      return [];
    }
    const terms = payload.terms
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length >= 3)
      .slice(0, 12);
    if (terms.length === 0) {
      return [];
    }

    const files = await listFiles(dir, 800);
    const results: { path: string; line: number; text: string }[] = [];
    const limit = payload.maxFiles ?? 40;

    for (const relative of files) {
      if (results.length >= limit) {
        break;
      }
      const absolute = join(dir, relative);
      if (!existsSync(absolute)) {
        continue;
      }
      const info = statSync(absolute);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        continue;
      }
      const pathHit = terms.some((term) => relative.toLowerCase().includes(term));
      const content = readFileSync(absolute, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const lower = lines[index].toLowerCase();
        if (terms.some((term) => lower.includes(term))) {
          results.push({
            path: relative,
            line: index + 1,
            text: lines[index].slice(0, 240),
          });
          break;
        }
      }
      if (pathHit && !results.some((item) => item.path === relative)) {
        results.push({ path: relative, line: 1, text: lines[0]?.slice(0, 240) ?? '' });
      }
    }

    return results.slice(0, limit);
  }

  private async wikiBranch(dir: string): Promise<string> {
    try {
      return await defaultBranchOf(dir);
    } catch {
      return WIKI_BRANCH_FALLBACK;
    }
  }

  private async shaOrUndefined(dir: string): Promise<string | undefined> {
    try {
      return await currentSha(dir);
    } catch {
      return undefined;
    }
  }

  private async walk(root: string): Promise<string[]> {
    const output: string[] = [];
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git') {
          continue;
        }
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(full);
        } else if (entry.isFile()) {
          output.push(full);
        }
      }
    }
    return output;
  }

  private toRepoPath(root: string, absolute: string): string {
    return normalize(absolute).replace(normalize(root + sep), '').replace(/\\/g, '/');
  }

  private safeJoin(root: string, relative: string): string {
    const resolved = normalize(join(root, relative));
    const base = normalize(root + sep);
    if (!resolved.startsWith(base)) {
      throw new Error('Invalid path');
    }
    return resolved;
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
