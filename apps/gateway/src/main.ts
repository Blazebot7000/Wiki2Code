import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApiExceptionFilter } from './app/api-exception.filter';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: true,
  });
  app.useBodyParser('json', { limit: '10mb' });
  // Only the local UI (desktop window on :3000, Vite dev server on :4200) may
  // call this API. Reflecting arbitrary origins would let any website drive the
  // signed-in GitHub account.
  app.enableCors({
    origin: [
      /^http:\/\/127\.0\.0\.1(:\d+)?$/,
      /^http:\/\/localhost(:\d+)?$/,
    ],
    credentials: true,
  });
  app.useGlobalFilters(new ApiExceptionFilter());

  // In the desktop build the gateway also serves the compiled web UI, so the
  // Electron window can load everything from one origin.
  const webDir =
    process.env.WIKI2CODE_WEB_DIR ?? join(__dirname, '..', '..', 'web', 'dist');
  if (existsSync(join(webDir, 'index.html'))) {
    app.useStaticAssets(webDir);
    Logger.log(`Serving web UI from ${webDir}`, 'Bootstrap');
  }

  app.setGlobalPrefix('api');

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '127.0.0.1');

  if (process.env.NX_READY_SIGNAL_SOCKET) {
    try {
      const load = new Function('s', 'return import(s)') as (
        s: string,
      ) => Promise<{ emitReadySignal(server: unknown): boolean }>;
      (await load('@nx/js/ready-signal')).emitReadySignal(app.getHttpServer());
    } catch {
      // @nx/js isn't installed
    }
  }

  Logger.log(`Wiki2Code gateway: http://127.0.0.1:${port}/api`, 'Bootstrap');
}

void bootstrap();
