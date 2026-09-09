import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { StorageService } from '../src/storage/storage.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storageService: StorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storageService = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let emailCounter = 0;

  async function captureConfirmationToken(email: string): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    return capturedToken;
  }

  async function registerAndLogin(): Promise<string> {
    const email = `videos_e2e_${++emailCounter}@example.com`;
    const token = await captureConfirmationToken(email);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    return res.body.access_token as string;
  }

  describe('POST /videos/upload-init', () => {
    it('returns 201 with video, upload_url, expires_at', async () => {
      const token = await registerAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'My Video',
          content_type: 'video/mp4',
          file_size: 1048576,
        })
        .expect(201);

      expect(res.body.video.id).toBeDefined();
      expect(res.body.video.unique_id).toMatch(/^[A-Za-z0-9_-]{12}$/);
      expect(res.body.video.status).toBe('draft');
      expect(res.body.upload_url).toBeDefined();
      expect(res.body.expires_at).toBeDefined();
    });

    it('returns 401 without authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos/upload-init')
        .send({
          title: 'My Video',
          content_type: 'video/mp4',
          file_size: 1048576,
        })
        .expect(401);
    });

    it('returns 400 when content_type is not a video MIME type', async () => {
      const token = await registerAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'My Video',
          content_type: 'application/pdf',
          file_size: 1048576,
        })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when file_size exceeds 10GB', async () => {
      const token = await registerAndLogin();

      await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Big Video',
          content_type: 'video/mp4',
          file_size: 10737418241,
        })
        .expect(400);
    });

    it('returns 400 when title is missing', async () => {
      const token = await registerAndLogin();

      await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${token}`)
        .send({ content_type: 'video/mp4', file_size: 1048576 })
        .expect(400);
    });
  });

  describe('POST /videos/:id/complete', () => {
    async function createDraftVideo(token: string) {
      const res = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Draft Video',
          content_type: 'video/mp4',
          file_size: 512,
        });
      return res.body;
    }

    it('returns 401 without authorization', async () => {
      await request(app.getHttpServer())
        .post(`/videos/some-uuid/complete`)
        .expect(401);
    });

    it('returns 404 for unknown video id', async () => {
      const token = await registerAndLogin();
      const unknownId = '00000000-0000-0000-0000-000000000000';

      const res = await request(app.getHttpServer())
        .post(`/videos/${unknownId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 403 when video belongs to another user', async () => {
      const token1 = await registerAndLogin();
      const token2 = await registerAndLogin();

      const { video } = await createDraftVideo(token1);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete`)
        .set('Authorization', `Bearer ${token2}`)
        .expect(403);

      expect(res.body.error).toBe('VIDEO_NOT_OWNED');
    });

    it('returns 422 when file not in MinIO', async () => {
      const token = await registerAndLogin();
      const { video } = await createDraftVideo(token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect(res.body.error).toBe('VIDEO_FILE_NOT_IN_STORAGE');
    });

    it('returns 202 with status=processing after successful upload to MinIO', async () => {
      const token = await registerAndLogin();
      const { video } = await createDraftVideo(token);

      await storageService.putObjectFromStream(
        video.storage_key,
        Buffer.from('fake video bytes'),
        'video/mp4',
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      expect(res.body.video.status).toBe('processing');
    });

    it('returns 409 when video is already processing', async () => {
      const token = await registerAndLogin();
      const { video } = await createDraftVideo(token);

      await storageService.putObjectFromStream(
        video.storage_key,
        Buffer.from('fake video bytes'),
        'video/mp4',
      );

      await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);

      expect(res.body.error).toBe('VIDEO_NOT_IN_DRAFT');
    });
  });

  describe('GET /videos/:uniqueId/stream', () => {
    it('returns 404 for unknown uniqueId', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/unknownid12345/stream')
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 422 for draft video', async () => {
      const token = await registerAndLogin();
      const { video } = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Draft', content_type: 'video/mp4', file_size: 512 })
        .then((r) => ({ video: r.body.video }));

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.unique_id}/stream`)
        .expect(422);

      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });

    it('returns 200 with Accept-Ranges header for full stream', async () => {
      const token = await registerAndLogin();

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Stream Test',
          content_type: 'video/mp4',
          file_size: 11,
        });

      const { video } = initRes.body;

      const videoBytes = Buffer.from('hello world');
      await storageService.putObjectFromStream(
        video.storage_key,
        videoBytes,
        'video/mp4',
      );

      await dataSource.query(
        `UPDATE videos SET status = 'ready', mime_type = 'video/mp4' WHERE id = $1`,
        [video.id],
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.unique_id}/stream`)
        .expect(200);

      expect(res.headers['accept-ranges']).toBe('bytes');
    });

    it('returns 206 with Content-Range header for Range request', async () => {
      const token = await registerAndLogin();

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Range Test',
          content_type: 'video/mp4',
          file_size: 11,
        });

      const { video } = initRes.body;

      const videoBytes = Buffer.from('hello world');
      await storageService.putObjectFromStream(
        video.storage_key,
        videoBytes,
        'video/mp4',
      );

      await dataSource.query(
        `UPDATE videos SET status = 'ready', mime_type = 'video/mp4' WHERE id = $1`,
        [video.id],
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.unique_id}/stream`)
        .set('Range', 'bytes=0-4')
        .expect(206);

      expect(res.headers['content-range']).toMatch(/^bytes 0-4\/11$/);
    });
  });

  describe('GET /videos/:uniqueId/download', () => {
    it('returns 404 for unknown uniqueId', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/unknownid12345/download')
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 422 for non-ready video', async () => {
      const token = await registerAndLogin();
      const { video } = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Draft', content_type: 'video/mp4', file_size: 512 })
        .then((r) => ({ video: r.body.video }));

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.unique_id}/download`)
        .expect(422);

      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });

    it('returns 200 with Content-Disposition: attachment', async () => {
      const token = await registerAndLogin();

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Download Test',
          content_type: 'video/mp4',
          file_size: 11,
        });

      const { video } = initRes.body;
      const videoBytes = Buffer.from('hello world');
      await storageService.putObjectFromStream(
        video.storage_key,
        videoBytes,
        'video/mp4',
      );

      await dataSource.query(
        `UPDATE videos SET status = 'ready', mime_type = 'video/mp4' WHERE id = $1`,
        [video.id],
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.unique_id}/download`)
        .expect(200);

      expect(res.headers['content-disposition']).toContain('attachment');
    });
  });
});
