import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { QueueModule } from '../queue/queue.module';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';
import { Video } from './entities/video.entity';
import { VideoProcessor } from './processors/video.processor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig],
    }),
    TypeOrmModule.forRootAsync({
      inject: [databaseConfig.KEY],
      useFactory: (cfg: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        password: cfg.password,
        database: cfg.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    QueueModule,
  ],
  providers: [VideoProcessor],
})
export class VideosWorkerModule {}
