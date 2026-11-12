import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
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
  hasChanges,
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
  scrubRemote,
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
export class GithubReposService implements OnModuleInit {
  private readonly logger = new Logger(GithubReposService.name);

  constructor(private readonly auth: GithubAuthService) {}

  /**
   * Older builds stored the access token inside `.git/config`. Strip it from
   * any checkout that is still around before doing anything else.
   */
  async onModuleInit(): Promise<void> {
    for (const repo of githubStore.read().repos) {
      for (const kind of ['code', 'wiki'] as const) {
        const dir = repoPath(repo.repoId, kind);
        if (existsSync(join(dir, '.git'))) {
          await scrubRemote(dir);
        }
      }
    }
  }

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
      // Enabling the wiki needs admin rights. Users can still connect a repo
      // they only have read access to, so do not abort the whole flow.
      try {
        await client.enableWiki(payload.owner, payload.name);
        summary.hasWiki = true;
      } catch (error) {
        this.logger.warn(
          `Could not enable the wiki for ${summary.fullName}: ${this.describe(error)}`,
        );
      }
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
          remoteUrl(payload.owner, payload.name),
          summary.defaultBranch,
          token,
        );
      } else {
        await scrubRemote(codeDir);
        await fetchAndReset(codeDir, summary.defaultBranch, token);
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
        await cloneRepo(
          wikiDir,
          remoteUrl(payload.owner, payload.name, true),
          undefined,
          token,
        );
      } else {
        await scrubRemote(wikiDir);
        await fetchAndReset(wikiDir, await this.wikiBranch(wikiDir), token);
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
    const token = this.auth.requireToken();
    let codeError: string | undefined;
    let wikiError: string | undefined;

    // Re-clone when the earlier clone failed; otherwise fetch the latest.
    try {
      if (!existsSync(join(codeDir, '.git'))) {
        await cloneRepo(
          codeDir,
          remoteUrl(repo.owner, repo.name),
          repo.defaultBranch,
          token,
        );
      } else {
        await scrubRemote(codeDir);
        await fetchAndReset(codeDir, repo.defaultBranch, token);
      }
    } catch (error) {
      codeError = this.describe(error);
      this.logger.warn(`Code sync failed for ${repoId}: ${codeError}`);
    }

    try {
      if (!existsSync(join(wikiDir, '.git'))) {
        await cloneRepo(
          wikiDir,
          remoteUrl(repo.owner, repo.name, true),
          undefined,
          token,
        );
      } else {
        await scrubRemote(wikiDir);
        await fetchAndReset(wikiDir, await this.wikiBranch(wikiDir), token);
      }
    } catch (error) {
      wikiError =
        `The wiki has no pages yet. Create the first page at ` +
        `${repo.htmlUrl}/wiki/_new, then press Sync.`;
      this.logger.warn(`Wiki sync failed for ${repoId}: ${this.describe(error)}`);
    }

    const codeReady = existsSync(join(codeDir, '.git'));
    const wikiReady = existsSync(join(wikiDir, '.git'));
    const updated: ConnectedRepo = {
      ...repo,
      codeReady,
      wikiReady,
      wikiError:
        wikiError ?? (codeError ? `Code sync failed: ${codeError}` : undefined),
      lastCodeSha: await this.shaOrUndefined(codeDir),
      lastWikiSha: await this.shaOrUndefined(wikiDir),
      lastSyncedAt: new Date().toISOString(),
      wikiPageCount: wikiReady ? (await this.readWikiPages(repoId)).length : 0,
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
    const token = this.auth.requireToken();
    const changedPaths: string[] = [];

    let codeSha = repo.lastCodeSha;
    let wikiSha = repo.lastWikiSha;
    let codeChanged = false;
    let wikiChanged = false;
    let wikiError = repo.wikiError;

    // A clone that failed while connecting would otherwise stay unmonitored
    // forever. Retry it on every poll so temporary failures heal themselves.
    if (!existsSync(join(codeDir, '.git'))) {
      try {
        await cloneRepo(
          codeDir,
          remoteUrl(repo.owner, repo.name),
          repo.defaultBranch,
          token,
        );
      } catch (error) {
        this.logger.warn(
          `Code clone retry failed for ${repoId}: ${this.describe(error)}`,
        );
      }
    }
    if (!existsSync(join(wikiDir, '.git'))) {
      try {
        await cloneRepo(
          wikiDir,
          remoteUrl(repo.owner, repo.name, true),
          undefined,
          token,
        );
        wikiError = undefined;
      } catch (error) {
        wikiError =
          `The wiki has no pages yet. Create the first page at ` +
          `${repo.htmlUrl}/wiki/_new, then press Sync.`;
        this.logger.warn(
          `Wiki clone retry failed for ${repoId}: ${this.describe(error)}`,
        );
      }
    }

    const codeReady = existsSync(join(codeDir, '.git'));
    const wikiReady = existsSync(join(wikiDir, '.git'));

    if (codeReady) {
      if (!repo.lastCodeSha) {
        codeSha = await this.shaOrUndefined(codeDir);
        codeChanged = Boolean(codeSha);
      } else {
        const remote = await remoteSha(codeDir, repo.defaultBranch, token);
        if (remote && remote !== repo.lastCodeSha) {
          const previous = repo.lastCodeSha;
          await fetchAndReset(codeDir, repo.defaultBranch, token);
          codeSha = await currentSha(codeDir);
          codeChanged = true;
          changedPaths.push(
            ...(await changedFiles(codeDir, previous, codeSha)),
          );
        }
      }
    }

    if (wikiReady) {
      const branch = await this.wikiBranch(wikiDir);
      if (!repo.lastWikiSha) {
        wikiSha = await this.shaOrUndefined(wikiDir);
        wikiChanged = Boolean(wikiSha);
      } else {
        const remote = await remoteSha(wikiDir, branch, token);
        if (remote && remote !== repo.lastWikiSha) {
          await fetchAndReset(wikiDir, branch, token);
          wikiSha = await currentSha(wikiDir);
          wikiChanged = true;
        }
      }
    }

    let wikiPageCount = wikiReady ? repo.wikiPageCount : 0;
    if (wikiReady && (wikiChanged || !repo.wikiReady)) {
      wikiPageCount = (await this.readWikiPages(repoId)).length;
    }

    const repoChanged =
      codeChanged ||
      wikiChanged ||
      codeReady !== repo.codeReady ||
      wikiReady !== repo.wikiReady ||
      wikiError !== repo.wikiError ||
      wikiPageCount !== repo.wikiPageCount;

    if (repoChanged) {
      githubStore.update((state) => ({
        ...state,
        repos: state.repos.map((item) =>
          item.repoId === repoId
            ? {
                ...item,
                codeReady,
                wikiReady,
                wikiError,
                lastCodeSha: codeSha,
                lastWikiSha: wikiSha,
                lastSyncedAt: new Date().toISOString(),
                wikiPageCount,
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
    const token = this.auth.requireToken();
    const branch = await this.wikiBranch(wikiDir);

    // Start from the remote tip so the push cannot be rejected as a
    // non-fast-forward after a commit landed elsewhere.
    await scrubRemote(wikiDir);
    await fetchAndReset(wikiDir, branch, token);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, payload.markdown, 'utf8');

    if (!(await hasChanges(wikiDir))) {
      // The rewrite produced the exact same markdown. Treat it as a no-op
      // instead of failing with "nothing to commit".
      return {
        pageSlug: payload.pageSlug,
        commitSha: await currentSha(wikiDir),
        markdown: payload.markdown,
      };
    }

    const sha = await commitAll(
      wikiDir,
      payload.message ?? `docs: update ${payload.pageSlug}`,
      'Wiki2Code',
      'wiki2code@users.noreply.github.com',
    );
    await pushBranch(wikiDir, branch, token);

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
