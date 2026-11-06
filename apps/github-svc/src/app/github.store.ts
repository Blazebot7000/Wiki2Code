import type {
  ConnectedRepo,
  DevCycleJob,
  GithubAccount,
} from '@org/contracts';
import { dataPath, JsonStore, SecretStore } from '@org/server';

export interface GithubState {
  account?: GithubAccount;
  clientId?: string;
  repos: ConnectedRepo[];
  devJobs: DevCycleJob[];
}

export const githubStore = new JsonStore<GithubState>(
  dataPath('github-svc.json'),
  { repos: [], devJobs: [] },
);

export const githubSecrets = new SecretStore(
  dataPath('secrets', 'github.enc'),
  dataPath('secrets', 'github.key'),
);
