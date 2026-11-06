import { Injectable, Logger } from '@nestjs/common';
import type {
  DeviceFlowPoll,
  DeviceFlowStart,
  GithubAccount,
} from '@org/contracts';
import {
  GithubClient,
  newId,
  pollDeviceFlow,
  startDeviceFlow,
} from '@org/server';
import { githubSecrets, githubStore } from './github.store';

interface DeviceSession {
  deviceCode: string;
  clientId: string;
  interval: number;
  expiresAt: number;
  lastPollAt: number;
}

@Injectable()
export class GithubAuthService {
  private readonly logger = new Logger(GithubAuthService.name);
  private readonly sessions = new Map<string, DeviceSession>();

  getToken(): string | undefined {
    return githubSecrets.get<string>('token');
  }

  requireToken(): string {
    const token = this.getToken();
    if (!token) {
      throw new Error('GitHub is not connected. Sign in first.');
    }
    return token;
  }

  client(): GithubClient {
    return new GithubClient(this.requireToken());
  }

  getClientId(override?: string): string {
    const clientId =
      override?.trim() ||
      githubStore.read().clientId ||
      process.env.WIKI2CODE_GITHUB_CLIENT_ID?.trim();
    if (!clientId) {
      throw new Error(
        'No GitHub OAuth App client ID configured. Create a free OAuth App at ' +
          'https://github.com/settings/applications/new (enable device flow), ' +
          'then paste its client ID here. Alternatively use a personal access token.',
      );
    }
    return clientId;
  }

  async startDevice(payload: { clientId?: string }): Promise<DeviceFlowStart> {
    const clientId = this.getClientId(payload.clientId);
    githubStore.update((state) => ({ ...state, clientId }));

    const flow = await startDeviceFlow(clientId);
    const sessionId = newId('ghdev');
    this.sessions.set(sessionId, {
      deviceCode: flow.deviceCode,
      clientId,
      interval: flow.interval,
      expiresAt: Date.now() + flow.expiresIn * 1000,
      lastPollAt: 0,
    });

    return {
      sessionId,
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      expiresIn: flow.expiresIn,
      interval: flow.interval,
    };
  }

  async pollDevice(payload: { sessionId: string }): Promise<DeviceFlowPoll> {
    const session = this.sessions.get(payload.sessionId);
    if (!session) {
      return { status: 'expired', message: 'Unknown sign-in session. Start again.' };
    }
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(payload.sessionId);
      return { status: 'expired', message: 'The device code expired. Start again.' };
    }
    if (Date.now() - session.lastPollAt < session.interval * 1000) {
      return { status: 'pending' };
    }
    session.lastPollAt = Date.now();

    const result = await pollDeviceFlow(session.clientId, session.deviceCode);
    if (result.status === 'connected') {
      this.sessions.delete(payload.sessionId);
      const account = await this.persistToken(result.token);
      return { status: 'connected', account };
    }
    if (result.status === 'pending' || result.status === 'slow_down') {
      if (result.status === 'slow_down') {
        session.interval += 2;
      }
      return { status: 'pending' };
    }
    this.sessions.delete(payload.sessionId);
    return {
      status: result.status === 'denied' ? 'error' : result.status,
      message: result.message,
    };
  }

  async usePat(payload: { token: string }): Promise<GithubAccount> {
    const token = payload.token?.trim();
    if (!token) {
      throw new Error('Paste a GitHub personal access token first.');
    }
    const account = await new GithubClient(token).getUser();
    this.persistTokenWithAccount(token, account);
    return account;
  }

  async account(): Promise<GithubAccount | undefined> {
    const cached = githubStore.read().account;
    if (!cached || !this.getToken()) {
      return undefined;
    }
    return cached;
  }

  async refreshAccount(): Promise<GithubAccount | undefined> {
    const token = this.getToken();
    if (!token) {
      return undefined;
    }
    try {
      const account = await new GithubClient(token).getUser();
      this.persistTokenWithAccount(token, account);
      return account;
    } catch (error) {
      this.logger.warn(`GitHub token validation failed: ${String(error)}`);
      return githubStore.read().account;
    }
  }

  logout(): void {
    githubSecrets.remove('token');
    const state = githubStore.read();
    githubStore.write({
      clientId: state.clientId,
      devJobs: state.devJobs,
      repos: [],
    });
  }

  private async persistToken(token: string): Promise<GithubAccount> {
    const account = await new GithubClient(token).getUser();
    this.persistTokenWithAccount(token, account);
    return account;
  }

  private persistTokenWithAccount(token: string, account: GithubAccount): void {
    githubSecrets.set('token', token);
    githubStore.update((state) => ({ ...state, account }));
  }
}
