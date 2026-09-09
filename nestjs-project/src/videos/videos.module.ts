import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import storageConfig from '../config/storage.config';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ConfigModule.forFeature(storageConfig),
    ChannelsModule,
    QueueModule,
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [TypeOrmModule],
})
export class VideosModule {}
