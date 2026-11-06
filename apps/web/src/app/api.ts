import type {
  AiProviderId,
  ConnectedRepo,
  DevCycleJob,
  DevPlan,
  DeviceFlowPoll,
  DeviceFlowStart,
  GithubAccount,
  Highlight,
  HighlightStatus,
  ModelInfo,
  ProviderConnection,
  ProviderValidationResult,
  RepoSummary,
  ReviewJob,
  SetupState,
  SyncState,
  WikiPage,
  WikiPageMeta,
  WikiUpdateResult,
} from '@org/contracts';

function resolveBase(): string {
  const configured = import.meta.env.VITE_API_BASE as string | undefined;
  if (configured) {
    return configured.replace(/\/$/, '');
  }
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    return 'http://127.0.0.1:3000/api';
  }
  return '/api';
}

export const API_BASE = resolveBase();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(
      0,
      'Cannot reach the Wiki2Code backend. Is the app still starting?',
    );
  }

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) {
        message = body.message;
      }
    } catch {
      // keep the status message
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const api = {
  setup: () => request<SetupState>('/setup'),
  completeSetup: () => post<SetupState>('/setup/complete'),
  resetSetup: () => post<SetupState>('/setup/reset'),

  providers: () => request<ProviderConnection[]>('/providers'),
  validateProvider: (body: {
    provider: AiProviderId;
    apiKey?: string;
    baseUrl?: string;
  }) => post<ProviderValidationResult>('/providers/validate', body),
  addProvider: (body: {
    provider: AiProviderId;
    apiKey?: string;
    baseUrl?: string;
    label?: string;
  }) => post<ProviderConnection>('/providers', body),
  removeProvider: (id: string) =>
    request<{ ok: true }>(`/providers/${id}`, { method: 'DELETE' }),
  selectModel: (model: string, providerId?: string) =>
    post<{ selectedModel?: string; selectedProviderId?: string }>(
      '/providers/select',
      { model, providerId },
    ),
  models: () =>
    request<{
      models: ModelInfo[];
      selectedModel?: string;
      selectedProviderId?: string;
    }>('/models'),

  deviceStart: (clientId?: string) =>
    post<DeviceFlowStart>('/github/device/start', { clientId }),
  devicePoll: (sessionId: string) =>
    post<DeviceFlowPoll>('/github/device/poll', { sessionId }),
  usePat: (token: string) => post<GithubAccount>('/github/pat', { token }),
  account: () => request<GithubAccount | undefined>('/github/account'),
  logout: () => post<{ ok: true }>('/github/logout'),
  remoteRepos: () => request<RepoSummary[]>('/github/repos'),

  repos: () => request<ConnectedRepo[]>('/repos'),
  connectRepo: (owner: string, name: string) =>
    post<ConnectedRepo>('/repos', { owner, name }),
  disconnectRepo: (repoId: string) =>
    request<{ ok: true }>(`/repos/${repoId}`, { method: 'DELETE' }),
  activateRepo: (repoId: string) =>
    post<{ ok: true; activeRepoId: string }>(`/repos/${repoId}/activate`),
  syncRepo: (repoId: string) =>
    post<ConnectedRepo>(`/repos/${repoId}/sync`),

  wikiPages: (repoId: string) =>
    request<WikiPageMeta[]>(`/repos/${repoId}/wiki`),
  wikiPage: (repoId: string, slug: string) =>
    request<WikiPage>(
      `/repos/${repoId}/wiki/page?slug=${encodeURIComponent(slug)}`,
    ),
  updateWiki: (repoId: string, slug: string, markdown: string) =>
    request<WikiUpdateResult>(
      `/repos/${repoId}/wiki/page`,
      {
        method: 'PUT',
        body: JSON.stringify({ slug, markdown }),
      },
    ),

  codeTree: (repoId: string) =>
    request<string[]>(`/repos/${repoId}/code/tree`),
  readCode: (repoId: string, path: string) =>
    request<{ path: string; content: string }>(
      `/repos/${repoId}/code/file?path=${encodeURIComponent(path)}`,
    ),
  searchCode: (repoId: string, q: string) =>
    request<{ path: string; line: number; text: string }[]>(
      `/repos/${repoId}/code/search?q=${encodeURIComponent(q)}`,
    ),

  startReview: (repoId: string, body: { model?: string } = {}) =>
    post<ReviewJob>(`/repos/${repoId}/reviews`, body),
  review: (jobId: string) => request<ReviewJob>(`/reviews/${jobId}`),
  cancelReview: (jobId: string) =>
    post<{ ok: true }>(`/reviews/${jobId}/cancel`),
  reviews: (repoId: string) =>
    request<ReviewJob[]>(`/repos/${repoId}/reviews`),

  highlights: (repoId: string, pageSlug?: string) =>
    request<Highlight[]>(
      `/repos/${repoId}/highlights${
        pageSlug ? `?pageSlug=${encodeURIComponent(pageSlug)}` : ''
      }`,
    ),
  highlight: (id: string) => request<Highlight>(`/highlights/${id}`),
  updateHighlight: (id: string, status: HighlightStatus) =>
    request<Highlight>(`/highlights/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  fixWiki: (id: string, model?: string) =>
    post<WikiUpdateResult & { highlightId: string; updatedBlock: string }>(
      `/highlights/${id}/fix-wiki`,
      { model },
    ),
  planCode: (id: string, model?: string) =>
    post<DevPlan>(`/highlights/${id}/plan-code`, { model }),
  fixCode: (
    id: string,
    body: { model?: string; dryRun?: boolean; merge?: boolean } = {},
  ) => post<DevCycleJob>(`/highlights/${id}/fix-code`, body),
  devJob: (jobId: string) => request<DevCycleJob>(`/dev-jobs/${jobId}`),
  devJobs: (repoId: string) =>
    request<DevCycleJob[]>(`/repos/${repoId}/dev-jobs`),

  syncState: (repoId: string) =>
    request<SyncState>(`/repos/${repoId}/sync-state`),
  startWatch: (repoId: string, intervalMs?: number) =>
    post<SyncState>(`/repos/${repoId}/watch`, { intervalMs }),
  stopWatch: (repoId: string) =>
    request<SyncState>(`/repos/${repoId}/watch`, { method: 'DELETE' }),
  syncNow: (repoId: string) =>
    post<SyncState>(`/repos/${repoId}/sync-now`),
};

export function eventsUrl(repoId: string): string {
  return `${API_BASE}/events?repoId=${encodeURIComponent(repoId)}`;
}
