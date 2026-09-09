import { Test, TestingModule } from '@nestjs/testing';
import { StorageService } from './storage.service';
import storageConfig from '../config/storage.config';

const mockSend = jest.fn();
const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  CreateBucketCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

const buildConfig = () => ({
  minioEndpoint: 'minio',
  minioPort: 9000,
  minioAccessKey: 'access',
  minioSecretKey: 'secret',
  minioBucket: 'streamtube',
  minioUseSsl: false,
  presignedUrlExpirySeconds: 43200,
});

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    mockSend.mockReset();
    mockGetSignedUrl.mockReset();

    mockSend.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: storageConfig.KEY, useValue: buildConfig() },
      ],
    }).compile();

    service = module.get(StorageService);
  });

  describe('onModuleInit', () => {
    it('should create bucket if it does not exist', async () => {
      await service.onModuleInit();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should swallow BucketAlreadyOwnedByYou error', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error(), { Code: 'BucketAlreadyOwnedByYou' }),
      );
      await expect(service.onModuleInit()).resolves.not.toThrow();
    });

    it('should swallow BucketAlreadyExists error', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error(), { Code: 'BucketAlreadyExists' }),
      );
      await expect(service.onModuleInit()).resolves.not.toThrow();
    });

    it('should rethrow unexpected errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('network failure'));
      await expect(service.onModuleInit()).rejects.toThrow('network failure');
    });
  });

  describe('createPresignedPutUrl', () => {
    it('should call getSignedUrl with PutObjectCommand and correct params', async () => {
      mockGetSignedUrl.mockResolvedValue('https://minio/presigned-url');

      const url = await service.createPresignedPutUrl(
        'channels/c/videos/v/original',
        'video/mp4',
        3600,
      );

      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      const [, command, options] = mockGetSignedUrl.mock.calls[0] as [
        unknown,
        { input: { Bucket: string; Key: string; ContentType: string } },
        { expiresIn: number },
      ];
      expect(command.input.Bucket).toBe('streamtube');
      expect(command.input.Key).toBe('channels/c/videos/v/original');
      expect(command.input.ContentType).toBe('video/mp4');
      expect(options.expiresIn).toBe(3600);
      expect(url).toBe('https://minio/presigned-url');
    });
  });

  describe('objectExists', () => {
    it('should return true when HeadObject succeeds', async () => {
      mockSend.mockResolvedValue({ ContentLength: 100 });
      const result = await service.objectExists('some/key');
      expect(result).toBe(true);
    });

    it('should return false on NotFound error', async () => {
      mockSend.mockRejectedValue(
        Object.assign(new Error(), { name: 'NotFound' }),
      );
      const result = await service.objectExists('missing/key');
      expect(result).toBe(false);
    });

    it('should return false on NoSuchKey error', async () => {
      mockSend.mockRejectedValue(
        Object.assign(new Error(), { name: 'NoSuchKey' }),
      );
      const result = await service.objectExists('missing/key');
      expect(result).toBe(false);
    });

    it('should rethrow unexpected errors', async () => {
      mockSend.mockRejectedValue(new Error('access denied'));
      await expect(service.objectExists('key')).rejects.toThrow(
        'access denied',
      );
    });
  });

  describe('getObjectStream', () => {
    it('should call GetObjectCommand without Range when not provided', async () => {
      const { GetObjectCommand } = jest.requireMock('@aws-sdk/client-s3');
      mockSend.mockResolvedValue({
        Body: {},
        ContentLength: 500,
        ContentType: 'video/mp4',
      });

      await service.getObjectStream('some/key');

      expect(GetObjectCommand).toHaveBeenCalledWith(
        expect.not.objectContaining({ Range: expect.anything() }),
      );
    });

    it('should include Range in GetObjectCommand when provided', async () => {
      const { GetObjectCommand } = jest.requireMock('@aws-sdk/client-s3');
      mockSend.mockResolvedValue({
        Body: {},
        ContentLength: 1024,
        ContentType: 'video/mp4',
      });

      await service.getObjectStream('some/key', 'bytes=0-1023');

      expect(GetObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Range: 'bytes=0-1023' }),
      );
    });

    it('should return contentLength and contentType from response', async () => {
      mockSend.mockResolvedValue({
        Body: {},
        ContentLength: 2048,
        ContentType: 'video/webm',
      });
      const result = await service.getObjectStream('some/key');
      expect(result.contentLength).toBe(2048);
      expect(result.contentType).toBe('video/webm');
    });
  });

  describe('S3Client initialization', () => {
    it('should initialize S3Client with forcePathStyle: true', () => {
      const { S3Client } = jest.requireMock('@aws-sdk/client-s3');
      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({ forcePathStyle: true }),
      );
    });

    it('should use http endpoint when minioUseSsl is false', () => {
      const { S3Client } = jest.requireMock('@aws-sdk/client-s3');
      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'http://minio:9000' }),
      );
    });
  });
});
