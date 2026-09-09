import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Readable } from 'stream';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import storageConfig from '../config/storage.config';
import {
  VideoFileNotInStorageException,
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { VIDEO_QUEUE } from '../queue/queue.constants';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const MOCK_CFG = { presignedUrlExpirySeconds: 3600 };

function makeVideo(overrides: Partial<Video> = {}): Video {
  const v = new Video();
  v.id = 'video-uuid';
  v.unique_id = 'abc123def456';
  v.channel_id = 'channel-uuid';
  v.title = 'Test Video';
  v.status = VideoStatus.DRAFT;
  v.storage_key = 'channels/channel-uuid/videos/video-uuid/original';
  v.thumbnail_key = null;
  v.duration = null;
  v.file_size = '1048576';
  v.mime_type = 'video/mp4';
  v.metadata = null;
  v.processing_error = null;
  v.created_at = new Date('2026-01-01T00:00:00Z');
  v.updated_at = new Date('2026-01-01T00:00:00Z');
  return Object.assign(v, overrides);
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: Record<string, jest.Mock>;
  let storageService: Record<string, jest.Mock>;
  let channelsService: Record<string, jest.Mock>;
  let videoQueue: Record<string, jest.Mock>;

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
    };
    storageService = {
      createPresignedPutUrl: jest.fn(),
      objectExists: jest.fn(),
      getObjectStream: jest.fn(),
      getObjectSize: jest.fn(),
    };
    channelsService = { findChannelByUserId: jest.fn() };
    videoQueue = { add: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: ChannelsService, useValue: channelsService },
        { provide: getQueueToken(VIDEO_QUEUE), useValue: videoQueue },
        { provide: storageConfig.KEY, useValue: MOCK_CFG },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    const dto: InitiateUploadDto = {
      title: 'My Video',
      content_type: 'video/mp4',
      file_size: 1048576,
    };

    it('finds channel by userId', async () => {
      const channel = { id: 'ch-id' };
      channelsService.findChannelByUserId.mockResolvedValue(channel);
      storageService.createPresignedPutUrl.mockResolvedValue(
        'https://minio/presigned',
      );
      const video = makeVideo();
      videoRepository.create.mockReturnValue(video);
      videoRepository.save.mockResolvedValue(video);

      await service.initiateUpload('user-id', dto);

      expect(channelsService.findChannelByUserId).toHaveBeenCalledWith(
        'user-id',
      );
    });

    it('calls createPresignedPutUrl with correct args', async () => {
      const channel = { id: 'ch-id' };
      channelsService.findChannelByUserId.mockResolvedValue(channel);
      storageService.createPresignedPutUrl.mockResolvedValue(
        'https://minio/presigned',
      );
      const video = makeVideo();
      videoRepository.create.mockReturnValue(video);
      videoRepository.save.mockResolvedValue(video);

      await service.initiateUpload('user-id', dto);

      expect(storageService.createPresignedPutUrl).toHaveBeenCalledWith(
        expect.stringMatching(/^channels\/ch-id\/videos\/.+\/original$/),
        'video/mp4',
        3600,
      );
    });

    it('saves video with status=draft and correct fields', async () => {
      const channel = { id: 'ch-id' };
      channelsService.findChannelByUserId.mockResolvedValue(channel);
      storageService.createPresignedPutUrl.mockResolvedValue(
        'https://minio/presigned',
      );
      const video = makeVideo();
      videoRepository.create.mockReturnValue(video);
      videoRepository.save.mockResolvedValue(video);

      await service.initiateUpload('user-id', dto);

      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'ch-id',
          title: 'My Video',
          status: VideoStatus.DRAFT,
          mime_type: 'video/mp4',
        }),
      );
    });

    it('returns video + uploadUrl + expiresAt', async () => {
      const channel = { id: 'ch-id' };
      channelsService.findChannelByUserId.mockResolvedValue(channel);
      storageService.createPresignedPutUrl.mockResolvedValue(
        'https://minio/presigned',
      );
      const video = makeVideo();
      videoRepository.create.mockReturnValue(video);
      videoRepository.save.mockResolvedValue(video);

      const result = await service.initiateUpload('user-id', dto);

      expect(result.video).toBe(video);
      expect(result.uploadUrl).toBe('https://minio/presigned');
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it('unique_id has 12 URL-safe characters', async () => {
      const channel = { id: 'ch-id' };
      channelsService.findChannelByUserId.mockResolvedValue(channel);
      storageService.createPresignedPutUrl.mockResolvedValue(
        'https://minio/presigned',
      );
      videoRepository.create.mockImplementation((data) => ({ ...data }));
      videoRepository.save.mockImplementation(async (v) => v);

      const result = await service.initiateUpload('user-id', dto);

      expect(result.video.unique_id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    });
  });

  describe('completeUpload', () => {
    it('throws VideoNotFoundException when video not found', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(service.completeUpload('vid-id', 'user-id')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('throws VideoNotOwnedException when channel does not own video', async () => {
      const video = makeVideo({ channel_id: 'other-channel' });
      videoRepository.findOne.mockResolvedValue(video);
      channelsService.findChannelByUserId.mockResolvedValue({
        id: 'my-channel',
      });

      await expect(service.completeUpload('vid-id', 'user-id')).rejects.toThrow(
        VideoNotOwnedException,
      );
    });

    it('throws VideoNotInDraftException when status is not draft', async () => {
      const video = makeVideo({
        status: VideoStatus.PROCESSING,
        channel_id: 'ch-id',
      });
      videoRepository.findOne.mockResolvedValue(video);
      channelsService.findChannelByUserId.mockResolvedValue({ id: 'ch-id' });

      await expect(service.completeUpload('vid-id', 'user-id')).rejects.toThrow(
        VideoNotInDraftException,
      );
    });

    it('throws VideoFileNotInStorageException when object not in MinIO', async () => {
      const video = makeVideo({ channel_id: 'ch-id' });
      videoRepository.findOne.mockResolvedValue(video);
      channelsService.findChannelByUserId.mockResolvedValue({ id: 'ch-id' });
      storageService.objectExists.mockResolvedValue(false);

      await expect(service.completeUpload('vid-id', 'user-id')).rejects.toThrow(
        VideoFileNotInStorageException,
      );
    });

    it('updates status to processing and enqueues job on success', async () => {
      const video = makeVideo({ channel_id: 'ch-id' });
      videoRepository.findOne.mockResolvedValue(video);
      channelsService.findChannelByUserId.mockResolvedValue({ id: 'ch-id' });
      storageService.objectExists.mockResolvedValue(true);
      videoRepository.save.mockResolvedValue({
        ...video,
        status: VideoStatus.PROCESSING,
      });
      videoQueue.add.mockResolvedValue(undefined);

      const result = await service.completeUpload('video-uuid', 'user-id');

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(videoQueue.add).toHaveBeenCalledWith('process-video', {
        videoId: video.id,
        storageKey: video.storage_key,
        channelId: video.channel_id,
      });
    });
  });

  describe('findByUniqueId', () => {
    it('returns video when found', async () => {
      const video = makeVideo();
      videoRepository.findOne.mockResolvedValue(video);

      const result = await service.findByUniqueId('abc123def456');

      expect(result).toBe(video);
    });

    it('throws VideoNotFoundException when not found', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(service.findByUniqueId('unknown-id')).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });

  describe('streamVideo', () => {
    function makeRes() {
      const res: any = {
        status: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
      };
      return res;
    }

    function makeBody() {
      return { pipe: jest.fn() };
    }

    it('throws VideoNotFoundException when video not found', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.streamVideo('bad-id', undefined, makeRes()),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoNotReadyException when status is not ready', async () => {
      const video = makeVideo({ status: VideoStatus.PROCESSING });
      videoRepository.findOne.mockResolvedValue(video);

      await expect(
        service.streamVideo('abc123def456', undefined, makeRes()),
      ).rejects.toThrow(VideoNotReadyException);
    });

    it('returns full stream (200) when no Range header', async () => {
      const video = makeVideo({ status: VideoStatus.READY });
      videoRepository.findOne.mockResolvedValue(video);
      storageService.getObjectSize.mockResolvedValue(1000);
      const body = makeBody();
      storageService.getObjectStream.mockResolvedValue({
        body,
        contentLength: 1000,
        contentType: 'video/mp4',
      });
      const res = makeRes();

      await service.streamVideo('abc123def456', undefined, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Length': '1000',
          'Accept-Ranges': 'bytes',
        }),
      );
      expect(body.pipe).toHaveBeenCalledWith(res);
    });

    it('returns partial stream (206) with correct Content-Range when Range header present', async () => {
      const video = makeVideo({ status: VideoStatus.READY });
      videoRepository.findOne.mockResolvedValue(video);
      storageService.getObjectSize.mockResolvedValue(2000);
      const body = makeBody();
      storageService.getObjectStream.mockResolvedValue({
        body,
        contentLength: 1024,
        contentType: 'video/mp4',
      });
      const res = makeRes();

      await service.streamVideo('abc123def456', 'bytes=0-1023', res);

      expect(res.status).toHaveBeenCalledWith(206);
      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Range': 'bytes 0-1023/2000',
          'Content-Length': '1024',
        }),
      );
      expect(storageService.getObjectStream).toHaveBeenCalledWith(
        video.storage_key,
        'bytes=0-1023',
      );
    });
  });

  describe('downloadVideo', () => {
    function makeRes() {
      const res: any = {
        status: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
      };
      return res;
    }

    it('throws VideoNotFoundException when video not found', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(service.downloadVideo('bad-id', makeRes())).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('throws VideoNotReadyException when video not ready', async () => {
      const video = makeVideo({ status: VideoStatus.DRAFT });
      videoRepository.findOne.mockResolvedValue(video);

      await expect(
        service.downloadVideo('abc123def456', makeRes()),
      ).rejects.toThrow(VideoNotReadyException);
    });

    it('sets Content-Disposition: attachment header', async () => {
      const video = makeVideo({
        status: VideoStatus.READY,
        title: 'My Test Video',
      });
      videoRepository.findOne.mockResolvedValue(video);
      storageService.getObjectSize.mockResolvedValue(500);
      const body = new Readable({ read() {} });
      (body as any).pipe = jest.fn();
      storageService.getObjectStream.mockResolvedValue({
        body,
        contentLength: 500,
        contentType: 'video/mp4',
      });
      const res = makeRes();

      await service.downloadVideo('abc123def456', res);

      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Disposition': expect.stringContaining('attachment'),
        }),
      );
    });
  });
});
