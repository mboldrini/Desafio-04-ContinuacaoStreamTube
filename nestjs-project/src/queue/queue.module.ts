import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_QUEUE } from './queue.constants';

@Module({
  imports: [
    ConfigModule.forFeature(queueConfig),
    BullModule.forRootAsync({
      imports: [ConfigModule.forFeature(queueConfig)],
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: cfg.redisHost,
          port: cfg.redisPort,
        },
      }),
    }),
    BullModule.registerQueueAsync({
      name: VIDEO_QUEUE,
      useFactory: () => ({
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
