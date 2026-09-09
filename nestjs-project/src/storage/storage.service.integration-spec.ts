import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { Readable } from 'stream';
import { StorageService } from './storage.service';
import storageConfig from '../config/storage.config';

describe('StorageService (integration)', () => {
  let service: StorageService;
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forFeature(storageConfig)],
      providers: [StorageService],
    }).compile();

    service = module.get(StorageService);
    await service.onModuleInit();
  });

  afterAll(async () => {
    await module.close();
  });

  it('should confirm bucket exists after onModuleInit', async () => {
    await expect(service.onModuleInit()).resolves.not.toThrow();
  });

  it('should return false for objectExists on a missing key', async () => {
    const result = await service.objectExists(
      'non-existent/key-that-does-not-exist',
    );
    expect(result).toBe(false);
  });

  it('should upload and verify object existence', async () => {
    const key = `test/integration-${Date.now()}.txt`;
    const content = Buffer.from('hello integration test');

    await service.putObjectFromStream(key, content, 'text/plain');

    const exists = await service.objectExists(key);
    expect(exists).toBe(true);
  });

  it('should get object size after upload', async () => {
    const key = `test/size-check-${Date.now()}.txt`;
    const content = Buffer.from('size check content');

    await service.putObjectFromStream(key, content, 'text/plain');

    const size = await service.getObjectSize(key);
    expect(size).toBe(content.byteLength);
  });

  it('should stream object content after upload', async () => {
    const key = `test/stream-check-${Date.now()}.txt`;
    const content = 'streaming content test';
    await service.putObjectFromStream(key, Buffer.from(content), 'text/plain');

    const { body, contentLength } = await service.getObjectStream(key);
    expect(body).toBeInstanceOf(Readable);

    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
      );
    }
    const result = Buffer.concat(chunks).toString('utf8');
    expect(result).toBe(content);
    expect(contentLength).toBe(Buffer.from(content).byteLength);
  });

  it('should create a presigned PUT URL', async () => {
    const key = `test/presigned-${Date.now()}.mp4`;
    const url = await service.createPresignedPutUrl(key, 'video/mp4', 3600);
    expect(typeof url).toBe('string');
    expect(url).toContain(key);
  });
});
