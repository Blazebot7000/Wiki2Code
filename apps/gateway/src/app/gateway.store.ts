import { dataPath, JsonStore } from '@org/server';

export interface GatewayState {
  completed: boolean;
  activeRepoId?: string;
}

export const gatewayStore = new JsonStore<GatewayState>(
  dataPath('gateway.json'),
  { completed: false },
);
