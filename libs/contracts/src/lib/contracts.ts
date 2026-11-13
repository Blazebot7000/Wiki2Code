export type AiProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'opencode'
  | 'ollama';

export interface ProviderDefinition {
  id: AiProviderId;
  name: string;
  docsUrl: string;
  keyPlaceholder: string;
  requiresKey: boolean;
  defaultBaseUrl?: string;
  defaultModel: string;
}

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    docsUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-...',
    requiresKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-...',
    requiresKey: true,
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    docsUrl: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza...',
    requiresKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-pro',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    docsUrl: 'https://openrouter.ai/settings/keys',
    keyPlaceholder: 'sk-or-...',
    requiresKey: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    docsUrl: 'https://opencode.ai/console',
    keyPlaceholder: 'sk-...',
    requiresKey: true,
    defaultBaseUrl: 'https://opencode.ai/inference/openai/v1',
    defaultModel: 'claude-sonnet-5',
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    docsUrl: 'https://ollama.com/download',
    keyPlaceholder: 'not required',
    requiresKey: false,
    defaultBaseUrl: 'http://127.0.0.1:11434',
    defaultModel: 'qwen2.5-coder:14b',
  },
];

export interface ModelInfo {
  id: string;
  label: string;
  provider: AiProviderId;
  /** Connection that offers this model. Models can share an id across providers. */
  connectionId?: string;
  /** Human-readable provider/connection label, e.g. "OpenRouter (work)". */
  providerLabel?: string;
  contextWindow?: number;
  recommended?: boolean;
  /** True for models that cost nothing to use (local or :free tiers). */
  free?: boolean;
}

/**
 * Stable identity for a model across providers. The same model id can be
 * offered by several connections, so the connection is part of the key.
 */
export function modelKey(
  model: Pick<ModelInfo, 'id' | 'provider' | 'connectionId'>,
): string {
  return `${model.connectionId ?? model.provider}::${model.id}`;
}

export interface ModelsState {
  /** Models the user chose to show in the model dropdown. */
  models: ModelInfo[];
  /** Every model available from connected providers. */
  allModels: ModelInfo[];
  /** Keys of models hidden from the dropdown. */
  hiddenModels: string[];
  selectedModel?: string;
  selectedProviderId?: string;
}

export interface ProviderConnection {
  id: string;
  provider: AiProviderId;
  label: string;
  apiKeyMasked: string;
  baseUrl?: string;
  status: 'connected' | 'invalid';
  models: ModelInfo[];
  createdAt: string;
}

export interface ProviderValidationResult {
  ok: boolean;
  message: string;
  models: ModelInfo[];
  accountLabel?: string;
}

export interface GithubAccount {
  login: string;
  name?: string;
  avatarUrl?: string;
  htmlUrl?: string;
}

export interface RepoSummary {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  hasWiki: boolean;
  defaultBranch: string;
  htmlUrl: string;
  updatedAt?: string;
  description?: string | null;
}

export interface ConnectedRepo extends RepoSummary {
  repoId: string;
  wikiReady: boolean;
  codeReady: boolean;
  wikiError?: string;
  lastCodeSha?: string;
  lastWikiSha?: string;
  lastSyncedAt?: string;
  wikiPageCount: number;
  addedAt: string;
}

export interface WikiPageMeta {
  slug: string;
  title: string;
  path: string;
  order: number;
}

export interface WikiPage extends WikiPageMeta {
  markdown: string;
}

export type HighlightSeverity = 'info' | 'warning' | 'error';
export type HighlightStatus = 'open' | 'resolved' | 'dismissed' | 'stale';

export interface CodeReference {
  path: string;
  startLine?: number;
  endLine?: number;
  note?: string;
}

export interface Highlight {
  id: string;
  repoId: string;
  pageSlug: string;
  pageTitle: string;
  blockId: string;
  lineStart: number;
  lineEnd: number;
  quote: string;
  severity: HighlightSeverity;
  status: HighlightStatus;
  title: string;
  explanation: string;
  codeRefs: CodeReference[];
  wikiSuggestion: string;
  codePlan: string;
  model: string;
  commitSha: string;
  createdAt: string;
  updatedAt: string;
}

export type ReviewJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ReviewJob {
  id: string;
  repoId: string;
  model: string;
  status: ReviewJobStatus;
  stage: string;
  progress: number;
  total: number;
  highlightCount: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export type DevCycleStage =
  | 'planning'
  | 'branching'
  | 'editing'
  | 'installing'
  | 'building'
  | 'testing'
  | 'committing'
  | 'pushing'
  | 'opening-pr'
  | 'merging'
  | 'done'
  | 'failed';

export interface DevCycleStep {
  stage: DevCycleStage;
  message: string;
  at: string;
  ok?: boolean;
}

export interface DevCycleJob {
  id: string;
  repoId: string;
  highlightId: string;
  branch: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stage: DevCycleStage;
  steps: DevCycleStep[];
  prUrl?: string;
  error?: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt?: string;
}

export interface DeviceFlowStart {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceFlowPoll {
  status: 'pending' | 'connected' | 'expired' | 'error';
  message?: string;
  account?: GithubAccount;
}

export interface SetupState {
  providers: ProviderConnection[];
  selectedProviderId?: string;
  selectedModel?: string;
  github?: GithubAccount;
  repos: ConnectedRepo[];
  activeRepoId?: string;
  completed: boolean;
}

export interface SyncState {
  repoId: string;
  codeSha?: string;
  wikiSha?: string;
  checkedAt: string;
  pendingReview: boolean;
}

export interface WikiUpdateResult {
  pageSlug: string;
  commitSha: string;
  markdown: string;
}

export interface FileEdit {
  path: string;
  content?: string;
  delete?: boolean;
}

export interface DevPlan {
  summary: string;
  branchName: string;
  commitMessage: string;
  edits: FileEdit[];
  commands: { install?: string; build?: string; test?: string };
  rationale: string;
}

export interface ReviewRequest {
  repoId: string;
  model: string;
  incremental?: boolean;
  changedPaths?: string[];
}

export interface ApiError {
  statusCode: number;
  message: string;
}
