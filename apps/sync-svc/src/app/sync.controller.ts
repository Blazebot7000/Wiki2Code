import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { SYNC_PATTERNS } from '@org/contracts';
import { SyncService } from './sync.service';

@Controller()
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @MessagePattern(SYNC_PATTERNS.WATCH_START)
  start(payload: { repoId: string; intervalMs?: number; immediate?: boolean }) {
    return this.sync.start(payload);
  }

  @MessagePattern(SYNC_PATTERNS.WATCH_STOP)
  stop(payload: { repoId: string }) {
    return this.sync.stop(payload);
  }

  @MessagePattern(SYNC_PATTERNS.WATCH_LIST)
  list() {
    return this.sync.list();
  }

  @MessagePattern(SYNC_PATTERNS.STATE)
  state(payload: { repoId: string }) {
    return this.sync.state(payload);
  }

  @MessagePattern(SYNC_PATTERNS.TICK)
  tick(payload: { repoId: string }) {
    return this.sync.tick(payload);
  }
}
