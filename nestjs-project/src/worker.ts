import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { VideosWorkerModule } from './videos/videos-worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(VideosWorkerModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();
}

void bootstrap();
