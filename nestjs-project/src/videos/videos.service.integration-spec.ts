import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { DataSource, Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import { User } from '../users/entities/user.entity';
import { StorageModule } from '../storage/storage.module';
import { cleanAllTables } from '../test/create-test-data-source';
import storageConfig from '../config/storage.config';
import databaseConfig from '../config/database.config';
import { VIDEO_QUEUE } from '../queue/queue.constants';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let mockQueue: { add: jest.Mock };
  let mockChannelsService: { findChannelByUserId: jest.Mock };

  beforeAll(async () => {
    mockQueue = { add: jest.fn().mockResolvedValue(undefined) };
    mockChannelsService = { findChannelByUserId: jest.fn() };

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig],
          validationOptions: { allowUnknown: true },
        }),
        TypeOrmModule.forRootAsync({
          inject: [databaseConfig.KEY],
          useFactory: (cfg: {
            host: string;
            port: number;
            username: string;
            password: string;
            name: string;
          }) => ({
            type: 'postgres',
            host: cfg.host,
            port: cfg.port,
            username: cfg.username,
            password: cfg.password,
            database: cfg.name,
            entities: [User, Channel, RefreshToken, VerificationToken, Video],
            synchronize: true,
          }),
        }),
        TypeOrmModule.forFeature([Video, User, Channel]),
        StorageModule,
      ],
      providers: [
        VideosService,
        { provide: ChannelsService, useValue: mockChannelsService },
        { provide: getQueueToken(VIDEO_QUEUE), useValue: mockQueue },
      ],
    }).compile();

    service = module.get(VideosService);
    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
    userRepository = module.get(getRepositoryToken(User));
    channelRepository = module.get(getRepositoryToken(Channel));

    const storageService = module.get('StorageService');
    await storageService.onModuleInit();
  });

  afterAll(async () => {
    await module.close();
  });

  let userCounter = 0;
  async function seedUserAndChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vidsvc_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'testchannel',
        nickname: `ch${userCounter}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    mockQueue.add.mockClear();
    mockChannelsService.findChannelByUserId.mockReset();
  });

  describe('initiateUpload', () => {
    it('persists video with correct fields', async () => {
      const { user, channel } = await seedUserAndChannel();
      mockChannelsService.findChannelByUserId.mockResolvedValue(channel);

      const result = await service.initiateUpload(user.id, {
        title: 'Test Video',
        content_type: 'video/mp4',
        file_size: 1048576,
      });

      expect(result.video.id).toBeDefined();
      expect(result.video.channel_id).toBe(channel.id);
      expect(result.video.status).toBe(VideoStatus.DRAFT);
      expect(result.video.mime_type).toBe('video/mp4');
      expect(result.video.unique_id).toMatch(/^[A-Za-z0-9_-]{12}$/);

      const persisted = await videoRepository.findOne({
        where: { id: result.video.id },
      });
      expect(persisted).not.toBeNull();
      expect(persisted!.status).toBe(VideoStatus.DRAFT);
    });

    it('storage_key follows channels/{channelId}/videos/{videoId}/original pattern', async () => {
      const { user, channel } = await seedUserAndChannel();
      mockChannelsService.findChannelByUserId.mockResolvedValue(channel);

      const result = await service.initiateUpload(user.id, {
        title: 'Key Pattern Test',
        content_type: 'video/webm',
        file_size: 2048,
      });

      expect(result.video.storage_key).toMatch(
        new RegExp(`^channels/${channel.id}/videos/[0-9a-f-]+/original$`),
      );
    });
  });

  describe('completeUpload', () => {
    it('persists status=processing and enqueues job', async () => {
      const { user, channel } = await seedUserAndChannel();
      mockChannelsService.findChannelByUserId.mockResolvedValue(channel);

      const { video } = await service.initiateUpload(user.id, {
        title: 'Complete Test',
        content_type: 'video/mp4',
        file_size: 512,
      });

      const storageService = module.get('StorageService');
      await storageService.putObjectFromStream(
        video.storage_key!,
        Buffer.from('fake video data'),
        'video/mp4',
      );

      const updated = await service.completeUpload(video.id, user.id);

      expect(updated.status).toBe(VideoStatus.PROCESSING);
      expect(mockQueue.add).toHaveBeenCalledWith('process-video', {
        videoId: video.id,
        storageKey: video.storage_key,
        channelId: channel.id,
      });

      const persisted = await videoRepository.findOne({
        where: { id: video.id },
      });
      expect(persisted!.status).toBe(VideoStatus.PROCESSING);
    });
  });
});
