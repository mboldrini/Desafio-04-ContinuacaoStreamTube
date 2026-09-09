import { DataSource, QueryFailedError } from 'typeorm';
import {
  createTestDataSource,
  cleanAllTables,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Video, VideoStatus } from './video.entity';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let channelId: string;

  beforeAll(async () => {
    dataSource = createTestDataSource([
      User,
      Channel,
      RefreshToken,
      VerificationToken,
      Video,
    ]);
    await dataSource.initialize();

    await cleanAllTables(dataSource);

    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);

    const user = userRepo.create({
      email: 'videotest@example.com',
      password: 'hashed',
      is_confirmed: true,
    });
    await userRepo.save(user);

    const channel = channelRepo.create({
      name: 'videotest',
      nickname: 'videotest',
      user_id: user.id,
    });
    await channelRepo.save(channel);
    channelId = channel.id;
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('should save a video with status draft by default', async () => {
    const repo = dataSource.getRepository(Video);
    const video = repo.create({
      channel_id: channelId,
      title: 'Test Video',
      unique_id: 'abc123def456',
      storage_key: 'channels/x/videos/y/original',
      mime_type: 'video/mp4',
    });
    await repo.save(video);

    const found = await repo.findOneByOrFail({ id: video.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.processing_error).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.updated_at).toBeInstanceOf(Date);
  });

  it('should enforce unique_id uniqueness', async () => {
    const repo = dataSource.getRepository(Video);
    const first = repo.create({
      channel_id: channelId,
      title: 'First',
      unique_id: 'duplicate0001',
      storage_key: 'channels/x/videos/a/original',
    });
    await repo.save(first);

    const second = repo.create({
      channel_id: channelId,
      title: 'Second',
      unique_id: 'duplicate0001',
      storage_key: 'channels/x/videos/b/original',
    });
    await expect(repo.save(second)).rejects.toThrow(QueryFailedError);
  });

  it('should enforce FK constraint on channel_id', async () => {
    const repo = dataSource.getRepository(Video);
    const video = repo.create({
      channel_id: '00000000-0000-0000-0000-000000000000',
      title: 'Orphan',
      unique_id: 'orphan000001',
      storage_key: 'channels/x/videos/z/original',
    });
    await expect(repo.save(video)).rejects.toThrow(QueryFailedError);
  });

  it('should store and retrieve jsonb metadata', async () => {
    const repo = dataSource.getRepository(Video);
    const meta = { duration: 120.5, width: 1920, height: 1080, codec: 'h264' };
    const video = repo.create({
      channel_id: channelId,
      title: 'Metadata Video',
      unique_id: 'metavideo001',
      storage_key: 'channels/x/videos/m/original',
      status: VideoStatus.READY,
      duration: 120.5,
      metadata: meta,
      thumbnail_key: 'channels/x/videos/m/thumbnail.jpg',
    });
    await repo.save(video);

    const found = await repo.findOneByOrFail({ id: video.id });
    expect(found.status).toBe(VideoStatus.READY);
    expect(found.duration).toBe(120.5);
    expect(found.metadata).toEqual(meta);
    expect(found.thumbnail_key).toBe('channels/x/videos/m/thumbnail.jpg');
  });
});
