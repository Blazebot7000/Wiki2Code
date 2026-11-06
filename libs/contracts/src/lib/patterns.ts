export const DEFAULT_PORTS = {
  gateway: 3000,
  github: 4001,
  ai: 4002,
  review: 4003,
  sync: 4004,
} as const;

export const GITHUB_PATTERNS = {
  AUTH_DEVICE_START: 'github.auth.device.start',
  AUTH_DEVICE_POLL: 'github.auth.device.poll',
  AUTH_PAT: 'github.auth.pat',
  AUTH_ACCOUNT: 'github.auth.account',
  AUTH_LOGOUT: 'github.auth.logout',
  REPOS_LIST_REMOTE: 'github.repos.listRemote',
  REPO_CONNECT: 'github.repo.connect',
  REPO_DISCONNECT: 'github.repo.disconnect',
  REPO_LIST: 'github.repo.list',
  REPO_GET: 'github.repo.get',
  REPO_SYNC: 'github.repo.sync',
  REPO_POLL: 'github.repo.poll',
  WIKI_LIST: 'github.wiki.list',
  WIKI_GET: 'github.wiki.get',
  WIKI_UPDATE: 'github.wiki.update',
  CODE_TREE: 'github.code.tree',
  CODE_READ: 'github.code.read',
  CODE_SEARCH: 'github.code.search',
  DEVCYCLE_EXECUTE: 'github.devcycle.execute',
  DEVCYCLE_GET: 'github.devcycle.get',
  DEVCYCLE_LIST: 'github.devcycle.list',
} as const;

export const AI_PATTERNS = {
  PROVIDERS_LIST: 'ai.providers.list',
  PROVIDERS_VALIDATE: 'ai.providers.validate',
  PROVIDERS_ADD: 'ai.providers.add',
  PROVIDERS_REMOVE: 'ai.providers.remove',
  PROVIDERS_SELECT: 'ai.providers.select',
  MODELS_LIST: 'ai.models.list',
  REVIEW_START: 'ai.review.start',
  REVIEW_JOB: 'ai.review.job',
  REVIEW_CANCEL: 'ai.review.cancel',
  WIKI_REWRITE: 'ai.wiki.rewrite',
  DEV_PLAN: 'ai.dev.plan',
} as const;

export const REVIEW_PATTERNS = {
  HIGHLIGHTS_LIST: 'review.highlights.list',
  HIGHLIGHTS_GET: 'review.highlights.get',
  HIGHLIGHTS_REPLACE_PAGE: 'review.highlights.replacePage',
  HIGHLIGHTS_UPDATE: 'review.highlights.update',
  HIGHLIGHTS_MARK_STALE: 'review.highlights.markStale',
  JOBS_CREATE: 'review.jobs.create',
  JOBS_UPDATE: 'review.jobs.update',
  JOBS_GET: 'review.jobs.get',
  JOBS_LIST: 'review.jobs.list',
  STATE_VERSION: 'review.state.version',
} as const;

export const SYNC_PATTERNS = {
  WATCH_START: 'sync.watch.start',
  WATCH_STOP: 'sync.watch.stop',
  WATCH_LIST: 'sync.watch.list',
  STATE: 'sync.watch.state',
  TICK: 'sync.watch.tick',
} as const;

export const SETUP_PATTERNS = {
  STATE: 'setup.state',
  COMPLETE: 'setup.complete',
  RESET: 'setup.reset',
} as const;
