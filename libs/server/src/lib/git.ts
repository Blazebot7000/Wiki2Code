import { exec, execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

function redact(text: string): string {
  return text.replace(
    /https:\/\/[^@\s]*@github\.com/g,
    'https://***@github.com',
  );
}

function toError(tool: string, detail: string): Error {
  return new Error(`${tool} failed: ${redact(detail).trim()}`);
}

function failureDetail(error: unknown): string {
  const candidate = error as {
    stderr?: string;
    stdout?: string;
    message?: string;
  };
  return candidate.stderr || candidate.stdout || candidate.message || String(error);
}

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};

const GITHUB_HOST = 'https://github.com';

/**
 * Pass the token through a per-command HTTP header instead of embedding it in
 * the remote URL. Anything in `.git/config` survives restarts and is easy to
 * leak (backups, support bundles, accidentally zipped workspaces), so remotes
 * are always stored tokenless.
 */
function authArgs(token?: string): string[] {
  if (!token) {
    return [];
  }
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString(
    'base64',
  );
  return [
    '-c',
    `http.${GITHUB_HOST}/.extraheader=AUTHORIZATION: basic ${basic}`,
  ];
}

export async function runGit(
  args: string[],
  cwd: string,
  timeoutMs = 180_000,
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: GIT_ENV,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    throw toError(`git ${args[0]}`, failureDetail(error));
  }
}

export async function runShell(
  command: string,
  cwd: string,
  timeoutMs = 15 * 60_000,
  extraEnv: Record<string, string> = {},
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      env: { ...GIT_ENV, ...extraEnv },
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    throw toError(command, failureDetail(error));
  }
}

export function remoteUrl(owner: string, repo: string, wiki = false): string {
  const suffix = wiki ? '.wiki.git' : '.git';
  return `${GITHUB_HOST}/${owner}/${repo}${suffix}`;
}

export async function cloneRepo(
  dir: string,
  url: string,
  branch?: string,
  token?: string,
): Promise<void> {
  // A previous clone may have failed halfway and left a non-empty folder that
  // git refuses to clone into. Start from a clean directory in that case.
  if (existsSync(dir) && !existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
  }
  const args = [...authArgs(token), 'clone', '--no-tags', '--depth', '50'];
  if (branch) {
    args.push('--branch', branch);
  }
  args.push(url, dir);
  await runGit(args, process.cwd(), 10 * 60_000);
}

export async function fetchAndReset(
  dir: string,
  branch: string,
  token?: string,
): Promise<void> {
  await runGit(
    [...authArgs(token), 'fetch', '--depth', '50', 'origin', branch],
    dir,
  );
  await runGit(['reset', '--hard', `origin/${branch}`], dir);
}

/**
 * Remove credentials that older builds embedded in the clone's remote URL.
 * Safe to call on any directory: failures (not a repo, no origin) are ignored.
 */
export async function scrubRemote(dir: string): Promise<void> {
  try {
    const { stdout } = await runGit(['remote', 'get-url', 'origin'], dir);
    const url = stdout.trim();
    if (!url) {
      return;
    }
    const safe = url.replace(/^(https?:\/\/)[^@/]+@/i, '$1');
    if (safe !== url) {
      await runGit(['remote', 'set-url', 'origin', safe], dir);
    }
  } catch {
    // No remote or not a git checkout.
  }
}

export async function currentSha(dir: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', 'HEAD'], dir);
  return stdout.trim();
}

export async function remoteSha(
  dir: string,
  branch: string,
  token?: string,
): Promise<string | undefined> {
  const { stdout } = await runGit(
    [...authArgs(token), 'ls-remote', 'origin', `refs/heads/${branch}`],
    dir,
  );
  const line = stdout.trim().split(/\r?\n/)[0];
  return line ? line.split(/\s+/)[0] : undefined;
}

export async function defaultBranchOf(dir: string): Promise<string> {
  const { stdout } = await runGit(
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    dir,
  );
  const ref = stdout.trim();
  return ref.replace(/^origin\//, '') || 'main';
}

export async function changedFiles(
  dir: string,
  fromSha: string,
  toSha: string,
): Promise<string[]> {
  const { stdout } = await runGit(
    ['diff', '--name-only', fromSha, toSha],
    dir,
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function createBranch(
  dir: string,
  branch: string,
  from: string,
): Promise<void> {
  await runGit(['checkout', '-B', branch, from], dir);
}

export async function commitAll(
  dir: string,
  message: string,
  authorName: string,
  authorEmail: string,
): Promise<string> {
  await runGit(['add', '--all'], dir);
  await runGit(
    [
      '-c',
      `user.name=${authorName}`,
      '-c',
      `user.email=${authorEmail}`,
      'commit',
      '-m',
      message,
    ],
    dir,
  );
  return currentSha(dir);
}

export async function pushBranch(
  dir: string,
  branch: string,
  token?: string,
): Promise<void> {
  await runGit(
    [...authArgs(token), 'push', '-u', 'origin', branch],
    dir,
    10 * 60_000,
  );
}

export async function hasChanges(dir: string): Promise<boolean> {
  const { stdout } = await runGit(['status', '--porcelain'], dir);
  return stdout.trim().length > 0;
}

export async function listFiles(dir: string, max = 400): Promise<string[]> {
  const { stdout } = await runGit(
    ['ls-files'],
    dir,
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, max);
}

export async function readFileAt(
  dir: string,
  path: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(['show', `HEAD:${path}`], dir);
    return stdout;
  } catch {
    return undefined;
  }
}
