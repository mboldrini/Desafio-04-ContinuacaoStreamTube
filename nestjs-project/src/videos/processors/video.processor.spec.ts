import { Readable } from 'stream';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { VideoProcessor } from './video.processor';
import type { ProcessVideoJobData } from '../videos.service';

jest.mock('fluent-ffmpeg', () => {
  const mockFfmpeg: any = jest.fn(() => mockFfmpegInstance);
  const mockFfmpegInstance = {
    screenshots: jest.fn().mockReturnThis(),
    on: jest.fn().mockImplementation(function (
      this: any,
      event: string,
      cb: () => void,
    ) {
      if (event === 'end') cb();
      return this;
    }),
  };
  mockFfmpeg.ffprobe = jest.fn();
  return mockFfmpeg;
});

jest.mock('stream/promises', () => ({
  pipeline: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('fs', () => ({
  createWriteStream: jest.fn().mockReturnValue({}),
  createReadStream: jest.fn().mockReturnValue(new Readable({ read() {} })),
}));

jest.mock('fs/promises', () => ({
  unlink: jest.fn().mockResolvedValue(undefined),
}));

function makeJob(data: ProcessVideoJobData): Job<ProcessVideoJobData> {
  return {
    data,
    failedReason: undefined,
  } as unknown as Job<ProcessVideoJobData>;
}

const MOCK_FFPROBE_DATA: ffmpeg.FfprobeData = {
  streams: [{ codec_name: 'h264', width: 1920, height: 1080 }] as any,
  format: { duration: 120.5, bit_rate: 2000000 } as any,
  chapters: [],
};

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  let videoRepository: Record<string, jest.Mock>;
  let storageService: Record<string, jest.Mock>;

  beforeEach(async () => {
    videoRepository = {
      update: jest.fn().mockResolvedValue(undefined),
    };
    storageService = {
      getObjectStream: jest.fn().mockResolvedValue({
        body: new Readable({ read() {} }),
        contentLength: 1024,
        contentType: 'video/mp4',
      }),
      putObjectFromStream: jest.fn().mockResolvedValue(undefined),
    };

    (ffmpeg.ffprobe as jest.Mock).mockImplementation(
      (
        _path: string,
        cb: (err: Error | null, data: ffmpeg.FfprobeData) => void,
      ) => {
        cb(null, MOCK_FFPROBE_DATA);
      },
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    processor = module.get(VideoProcessor);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const jobData: ProcessVideoJobData = {
    videoId: 'vid-uuid',
    storageKey: 'channels/ch-id/videos/vid-uuid/original',
    channelId: 'ch-id',
  };

  describe('process', () => {
    it('downloads video, runs ffprobe and ffmpeg, uploads thumbnail, updates video to ready', async () => {
      const job = makeJob(jobData);

      await processor.process(job);

      expect(storageService.getObjectStream).toHaveBeenCalledWith(
        jobData.storageKey,
      );
      expect(ffmpeg.ffprobe).toHaveBeenCalledWith(
        expect.stringContaining('vid-uuid'),
        expect.any(Function),
      );
      expect(storageService.putObjectFromStream).toHaveBeenCalledWith(
        'channels/ch-id/videos/vid-uuid/thumbnail.jpg',
        expect.anything(),
        'image/jpeg',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        'vid-uuid',
        expect.objectContaining({
          status: VideoStatus.READY,
          duration: 120.5,
          thumbnail_key: 'channels/ch-id/videos/vid-uuid/thumbnail.jpg',
        }),
      );
    });

    it('cleans up temp files in finally block on success', async () => {
      const { unlink } = await import('fs/promises');
      const job = makeJob(jobData);

      await processor.process(job);

      expect(unlink).toHaveBeenCalledWith(expect.stringContaining('vid-uuid'));
    });

    it('cleans up temp files even when ffprobe fails', async () => {
      const { unlink } = await import('fs/promises');
      (ffmpeg.ffprobe as jest.Mock).mockImplementation(
        (_path: string, cb: (err: Error | null, data: any) => void) => {
          cb(new Error('ffprobe error'), null as any);
        },
      );
      const job = makeJob(jobData);

      await expect(processor.process(job)).rejects.toThrow('ffprobe error');

      expect(unlink).toHaveBeenCalledWith(expect.stringContaining('vid-uuid'));
    });
  });

  describe('onFailed', () => {
    it('updates video status to error with failedReason', async () => {
      const job = {
        data: jobData,
        failedReason: 'FFmpeg crashed',
      } as unknown as Job<ProcessVideoJobData>;

      await processor.onFailed(job);

      expect(videoRepository.update).toHaveBeenCalledWith('vid-uuid', {
        status: VideoStatus.ERROR,
        processing_error: 'FFmpeg crashed',
      });
    });

    it('uses fallback message when failedReason is undefined', async () => {
      const job = {
        data: jobData,
        failedReason: undefined,
      } as unknown as Job<ProcessVideoJobData>;

      await processor.onFailed(job);

      expect(videoRepository.update).toHaveBeenCalledWith('vid-uuid', {
        status: VideoStatus.ERROR,
        processing_error: 'Unknown processing error',
      });
    });
  });
});
