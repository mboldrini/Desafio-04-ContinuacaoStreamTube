import { join } from 'path';
import { tmpdir } from 'os';
import { createReadStream, createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { InjectRepository } from '@nestjs/typeorm';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import ffmpeg from 'fluent-ffmpeg';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { VIDEO_QUEUE } from '../../queue/queue.constants';
import type { ProcessVideoJobData } from '../videos.service';

@Processor(VIDEO_QUEUE)
export class VideoProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId, storageKey, channelId } = job.data;
    const tmpVideoPath = join(tmpdir(), `${videoId}-${Date.now()}.tmp`);
    let tmpThumbPath: string | undefined;

    try {
      const { body } = await this.storageService.getObjectStream(storageKey);
      await pipeline(body, createWriteStream(tmpVideoPath));

      const metadata = await new Promise<ffmpeg.FfprobeData>(
        (resolve, reject) => {
          ffmpeg.ffprobe(tmpVideoPath, (err, data) => {
            if (err)
              reject(err instanceof Error ? err : new Error(String(err)));
            else resolve(data);
          });
        },
      );

      const thumbFilename = `${videoId}-thumb.jpg`;
      tmpThumbPath = join(tmpdir(), thumbFilename);

      await new Promise<void>((resolve, reject) => {
        ffmpeg(tmpVideoPath)
          .screenshots({
            count: 1,
            timemarks: ['10%'],
            filename: thumbFilename,
            folder: tmpdir(),
            size: '1280x720',
          })
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err));
      });

      const thumbnailKey = `channels/${channelId}/videos/${videoId}/thumbnail.jpg`;
      await this.storageService.putObjectFromStream(
        thumbnailKey,
        createReadStream(tmpThumbPath),
        'image/jpeg',
      );

      await this.videoRepository.update(videoId, {
        status: VideoStatus.READY,
        duration: metadata.format.duration ?? null,
        metadata: metadata as unknown as Record<string, unknown>,
        thumbnail_key: thumbnailKey,
      } as any);
    } finally {
      try {
        await unlink(tmpVideoPath);
      } catch {
        /* already deleted */
      }
      if (tmpThumbPath) {
        try {
          await unlink(tmpThumbPath);
        } catch {
          /* already deleted */
        }
      }
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>): Promise<void> {
    await this.videoRepository.update(job.data.videoId, {
      status: VideoStatus.ERROR,
      processing_error: job.failedReason ?? 'Unknown processing error',
    });
  }
}
