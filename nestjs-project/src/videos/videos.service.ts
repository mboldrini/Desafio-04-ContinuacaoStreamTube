import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import type { Response } from 'express';
import { nanoid } from 'nanoid';
import storageConfig from '../config/storage.config';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import {
  VideoFileNotInStorageException,
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { VIDEO_PROCESS_JOB, VIDEO_QUEUE } from '../queue/queue.constants';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';

export interface ProcessVideoJobData {
  videoId: string;
  storageKey: string;
  channelId: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @InjectQueue(VIDEO_QUEUE) private readonly videoQueue: Queue,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<{ video: Video; uploadUrl: string; expiresAt: Date }> {
    const channel = await this.channelsService.findChannelByUserId(userId);
    const videoId = randomUUID();
    const uniqueId = nanoid(12);
    const storageKey = `channels/${channel.id}/videos/${videoId}/original`;

    const uploadUrl = await this.storageService.createPresignedPutUrl(
      storageKey,
      dto.content_type,
      this.storageCfg.presignedUrlExpirySeconds,
    );

    const expiresAt = new Date(
      Date.now() + this.storageCfg.presignedUrlExpirySeconds * 1000,
    );

    const video = await this.videoRepository.save(
      this.videoRepository.create({
        id: videoId,
        channel_id: channel.id,
        title: dto.title,
        unique_id: uniqueId,
        storage_key: storageKey,
        file_size: String(dto.file_size),
        mime_type: dto.content_type,
        status: VideoStatus.DRAFT,
      }),
    );

    return { video, uploadUrl, expiresAt };
  }

  async completeUpload(videoId: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();

    const channel = await this.channelsService.findChannelByUserId(userId);
    if (video.channel_id !== channel.id) throw new VideoNotOwnedException();

    if (video.status !== VideoStatus.DRAFT)
      throw new VideoNotInDraftException();

    const exists = await this.storageService.objectExists(video.storage_key!);
    if (!exists) throw new VideoFileNotInStorageException();

    video.status = VideoStatus.PROCESSING;
    const updated = await this.videoRepository.save(video);

    await this.videoQueue.add(VIDEO_PROCESS_JOB, {
      videoId: video.id,
      storageKey: video.storage_key!,
      channelId: video.channel_id,
    } satisfies ProcessVideoJobData);

    return updated;
  }

  async findByUniqueId(uniqueId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { unique_id: uniqueId },
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  async streamVideo(
    uniqueId: string,
    rangeHeader: string | undefined,
    res: Response,
  ): Promise<void> {
    const video = await this.findByUniqueId(uniqueId);
    if (video.status !== VideoStatus.READY) throw new VideoNotReadyException();

    const totalSize = await this.storageService.getObjectSize(
      video.storage_key!,
    );
    const contentType = video.mime_type ?? 'application/octet-stream';

    if (!rangeHeader) {
      const { body } = await this.storageService.getObjectStream(
        video.storage_key!,
      );
      res.status(200).set({
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(totalSize),
      });
      body.pipe(res);
      return;
    }

    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    const startByte = match ? parseInt(match[1], 10) : 0;
    const endByte = match && match[2] ? parseInt(match[2], 10) : totalSize - 1;
    const chunkSize = endByte - startByte + 1;

    const { body } = await this.storageService.getObjectStream(
      video.storage_key!,
      `bytes=${startByte}-${endByte}`,
    );

    res.status(206).set({
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${startByte}-${endByte}/${totalSize}`,
      'Content-Length': String(chunkSize),
    });
    body.pipe(res);
  }

  async downloadVideo(uniqueId: string, res: Response): Promise<void> {
    const video = await this.findByUniqueId(uniqueId);
    if (video.status !== VideoStatus.READY) throw new VideoNotReadyException();

    const totalSize = await this.storageService.getObjectSize(
      video.storage_key!,
    );
    const { body } = await this.storageService.getObjectStream(
      video.storage_key!,
    );

    const sanitizedTitle =
      video.title.replace(/s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '') || 'video';

    res.status(200).set({
      'Content-Type': video.mime_type ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${sanitizedTitle}.mp4"`,
      'Content-Length': String(totalSize),
      'Accept-Ranges': 'bytes',
    });
    body.pipe(res);
  }
}
