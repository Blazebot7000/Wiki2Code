import { Injectable, Logger } from '@nestjs/common';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import type {
  DevCycleJob,
  DevCycleStage,
  DevPlan,
} from '@org/contracts';
import {
  cloneRepo,
  commitAll,
  createBranch,
  fetchAndReset,
  hasChanges,
  newId,
  pushBranch,
  remoteUrl,
  repoPath,
  runShell,
  scrubRemote,
  truncate,
} from '@org/server';
import { GithubAuthService } from './github-auth.service';
import { githubStore } from './github.store';
import { GithubReposService } from './github-repos.service';

const ALLOWED_COMMAND =
  /^(npm|npx|pnpm|yarn|node|python|python3|py|pytest|uv|cargo|go|dotnet|mvn|gradle|make|bash|sh)\b/i;
const FORBIDDEN_SHELL = /[;&|><`$]/;

@Injectable()
export class DevCycleService {
  private readonly logger = new Logger(DevCycleService.name);

  constructor(
    private readonly auth: GithubAuthService,
    private readonly repos: GithubReposService,
  ) {}

  start(payload: {
    repoId: string;
    highlightId: string;
    plan: DevPlan;
    dryRun?: boolean;
    merge?: boolean;
  }): DevCycleJob {
    const job: DevCycleJob = {
      id: newId('dev'),
      repoId: payload.repoId,
      highlightId: payload.highlightId,
      branch: this.branchName(payload.plan.branchName),
      status: 'running',
      stage: 'planning',
      steps: [
        {
          stage: 'planning',
          message: payload.plan.summary,
          at: new Date().toISOString(),
          ok: true,
        },
      ],
      dryRun: payload.dryRun ?? false,
      startedAt: new Date().toISOString(),
    };

    githubStore.update((state) => ({
      ...state,
      devJobs: [job, ...state.devJobs].slice(0, 20),
    }));

    void this.run(job, payload).catch((error) => {
      this.fail(job.id, error instanceof Error ? error.message : String(error));
    });

    return job;
  }

  get(jobId: string): DevCycleJob | undefined {
    return githubStore.read().devJobs.find((item) => item.id === jobId);
  }

  list(repoId: string): DevCycleJob[] {
    return githubStore
      .read()
      .devJobs.filter((item) => item.repoId === repoId);
  }

  private async run(
    job: DevCycleJob,
    payload: {
      repoId: string;
      plan: DevPlan;
      dryRun?: boolean;
      merge?: boolean;
    },
  ): Promise<void> {
    const repo = this.repos.get(payload.repoId);
    const dir = repoPath(payload.repoId, 'code');
    const token = this.auth.requireToken();
    if (!existsSync(join(dir, '.git'))) {
      await cloneRepo(
        dir,
        remoteUrl(repo.owner, repo.name),
        repo.defaultBranch,
        token,
      );
    } else {
      await scrubRemote(dir);
    }

    if (await hasChanges(dir)) {
      throw new Error(
        'The local checkout has uncommitted changes. Commit or discard them before running an automated fix.',
      );
    }

    this.step(job.id, 'branching', `Checking out ${repo.defaultBranch}`);
    await fetchAndReset(dir, repo.defaultBranch, token);
    await createBranch(dir, job.branch, `origin/${repo.defaultBranch}`);

    this.step(job.id, 'editing', `Applying ${payload.plan.edits.length} file edit(s)`);
    for (const edit of payload.plan.edits) {
      const absolute = this.safeJoin(dir, edit.path);
      if (edit.delete) {
        rmSync(absolute, { force: true });
        continue;
      }
      if (typeof edit.content !== 'string') {
        throw new Error(`Edit for ${edit.path} has no content.`);
      }
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, edit.content, 'utf8');
    }

    const commands = payload.plan.commands ?? {};
    if (commands.install) {
      await this.runCommand(job.id, 'installing', commands.install, dir);
    }
    if (commands.build) {
      await this.runCommand(job.id, 'building', commands.build, dir);
    }
    if (commands.test) {
      await this.runCommand(job.id, 'testing', commands.test, dir);
    }

    if (!(await hasChanges(dir))) {
      throw new Error('The proposed plan produced no file changes.');
    }

    if (payload.dryRun) {
      this.step(
        job.id,
        'done',
        'Dry run complete. Changes are in the local checkout and were not committed.',
        true,
      );
      this.finish(job.id, 'completed');
      return;
    }

    this.step(job.id, 'committing', payload.plan.commitMessage);
    const sha = await commitAll(
      dir,
      payload.plan.commitMessage,
      'Wiki2Code Agent',
      'wiki2code-agent@users.noreply.github.com',
    );
    this.logger.log(`Committed ${sha} on ${job.branch}`);

    this.step(job.id, 'pushing', `Pushing ${job.branch}`);
    await pushBranch(dir, job.branch, token);

    this.step(job.id, 'opening-pr', 'Opening pull request');
    const pull = await this.auth.client().createPullRequest(repo.owner, repo.name, {
      title: payload.plan.summary,
      head: job.branch,
      base: repo.defaultBranch,
      body: [
        payload.plan.summary,
        '',
        '### Rationale',
        payload.plan.rationale,
        '',
        '_Generated by Wiki2Code from a wiki/code mismatch review._',
      ].join('\n'),
    });

    if (payload.merge !== false) {
      this.step(job.id, 'merging', `Merging pull request #${pull.number}`);
      await this.auth.client().mergePullRequest(repo.owner, repo.name, pull.number);
    }

    this.step(job.id, 'done', `Pull request: ${pull.html_url}`, true);
    this.finish(job.id, 'completed', pull.html_url);

    await fetchAndReset(dir, repo.defaultBranch, token);
  }

  private async runCommand(
    jobId: string,
    stage: DevCycleStage,
    command: string,
    cwd: string,
  ): Promise<void> {
    if (!ALLOWED_COMMAND.test(command.trim()) || FORBIDDEN_SHELL.test(command)) {
      throw new Error(
        `Refusing to run command "${command}". Only plain build/test commands are allowed.`,
      );
    }
    this.step(jobId, stage, command);
    const result = await runShell(command, cwd, 20 * 60_000);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    this.step(
      jobId,
      stage,
      output ? truncate(output, 1200) : `${command} finished`,
      true,
    );
  }

  private step(
    jobId: string,
    stage: DevCycleStage,
    message: string,
    ok?: boolean,
  ): void {
    githubStore.update((state) => ({
      ...state,
      devJobs: state.devJobs.map((item) =>
        item.id === jobId
          ? {
              ...item,
              stage,
              steps: [
                ...item.steps,
                { stage, message, at: new Date().toISOString(), ok },
              ],
            }
          : item,
      ),
    }));
  }

  private finish(
    jobId: string,
    status: 'completed' | 'failed',
    prUrl?: string,
  ): void {
    githubStore.update((state) => ({
      ...state,
      devJobs: state.devJobs.map((item) =>
        item.id === jobId
          ? {
              ...item,
              status,
              stage: status === 'completed' ? 'done' : 'failed',
              prUrl: prUrl ?? item.prUrl,
              finishedAt: new Date().toISOString(),
            }
          : item,
      ),
    }));
  }

  private fail(jobId: string, message: string): void {
    this.logger.warn(`Dev cycle ${jobId} failed: ${message}`);
    this.step(jobId, 'failed', message, false);
    githubStore.update((state) => ({
      ...state,
      devJobs: state.devJobs.map((item) =>
        item.id === jobId
          ? {
              ...item,
              status: 'failed',
              error: message,
              finishedAt: new Date().toISOString(),
            }
          : item,
      ),
    }));
  }

  private branchName(input: string): string {
    const slug = input
      .toLowerCase()
      .replace(/[^a-z0-9/.-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/\/{2,}/g, '/')
      .replace(/^[./-]+|[./-]+$/g, '')
      .slice(0, 60);
    return `wiki2code/${slug || 'fix'}-${Date.now().toString(36)}`;
  }

  private safeJoin(root: string, relative: string): string {
    const resolved = normalize(join(root, relative));
    const base = normalize(root + sep);
    if (!resolved.startsWith(base)) {
      throw new Error(`Refusing to write outside the repository: ${relative}`);
    }
    return resolved;
  }
}
