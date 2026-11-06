import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { DEFAULT_PORTS } from '@org/contracts';
import { RpcErrorFilter } from '@org/server';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const port = Number(process.env.SYNC_SVC_PORT ?? DEFAULT_PORTS.sync);
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port },
    },
  );
  app.useGlobalFilters(new RpcErrorFilter());
  await app.listen();
  Logger.log(`sync-svc listening on tcp://127.0.0.1:${port}`, 'Bootstrap');
}

void bootstrap();
