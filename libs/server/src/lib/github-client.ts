import type { RepoSummary } from '@org/contracts';

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}

interface RawRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  has_wiki: boolean;
  default_branch: string;
  html_url: string;
  updated_at?: string;
  description?: string | null;
  owner: { login: string };
}

interface RawUser {
  login: string;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
}

export class GithubClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://api.github.com',
  ) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Wiki2Code',
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      let message = `GitHub request failed (${response.status})`;
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message) {
          message = body.message;
        }
      } catch {
        // keep the status-only message
      }
      throw new GithubError(response.status, message);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  async getUser(): Promise<{
    login: string;
    name?: string;
    avatarUrl?: string;
    htmlUrl?: string;
  }> {
    const user = await this.request<RawUser>('/user');
    return {
      login: user.login,
      name: user.name ?? undefined,
      avatarUrl: user.avatar_url,
      htmlUrl: user.html_url,
    };
  }

  async listRepos(): Promise<RepoSummary[]> {
    const repos = await this.request<RawRepo[]>(
      '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
    );
    return repos.map((repo) => this.mapRepo(repo));
  }

  async getRepo(owner: string, name: string): Promise<RepoSummary> {
    const repo = await this.request<RawRepo>(`/repos/${owner}/${name}`);
    return this.mapRepo(repo);
  }

  async enableWiki(owner: string, name: string): Promise<void> {
    await this.request<RawRepo>(`/repos/${owner}/${name}`, {
      method: 'PATCH',
      body: JSON.stringify({ has_wiki: true }),
    });
  }

  async latestCommitSha(
    owner: string,
    name: string,
    branch: string,
  ): Promise<string> {
    const commit = await this.request<{ sha: string }>(
      `/repos/${owner}/${name}/commits/${encodeURIComponent(branch)}`,
    );
    return commit.sha;
  }

  async createPullRequest(
    owner: string,
    name: string,
    input: { title: string; head: string; base: string; body: string },
  ): Promise<{ number: number; html_url: string }> {
    return this.request<{ number: number; html_url: string }>(
      `/repos/${owner}/${name}/pulls`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }

  async mergePullRequest(
    owner: string,
    name: string,
    number: number,
    method: 'merge' | 'squash' | 'rebase' = 'squash',
  ): Promise<void> {
    await this.request(`/repos/${owner}/${name}/pulls/${number}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ merge_method: method }),
    });
  }

  private mapRepo(repo: RawRepo): RepoSummary {
    return {
      id: repo.id,
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      hasWiki: repo.has_wiki,
      defaultBranch: repo.default_branch,
      htmlUrl: repo.html_url,
      updatedAt: repo.updated_at,
      description: repo.description ?? null,
    };
  }
}
