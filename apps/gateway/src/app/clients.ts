import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { DEFAULT_PORTS } from '@org/contracts';
import { createTcpClient } from '@org/server';

/**
 * One TCP client per microservice, shared by every gateway controller.
 */
@Injectable()
export class Clients implements OnModuleDestroy {
  readonly github: ClientProxy = createTcpClient(
    Number(process.env.GITHUB_SVC_PORT ?? DEFAULT_PORTS.github),
  );
  readonly ai: ClientProxy = createTcpClient(
    Number(process.env.AI_SVC_PORT ?? DEFAULT_PORTS.ai),
  );
  readonly review: ClientProxy = createTcpClient(
    Number(process.env.REVIEW_SVC_PORT ?? DEFAULT_PORTS.review),
  );
  readonly sync: ClientProxy = createTcpClient(
    Number(process.env.SYNC_SVC_PORT ?? DEFAULT_PORTS.sync),
  );

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(
      [this.github, this.ai, this.review, this.sync].map((client) =>
        client.close(),
      ),
    );
  }
}
