import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  minioEndpoint: process.env.MINIO_ENDPOINT || 'minio',
  minioPort: parseInt(process.env.MINIO_PORT || '9000', 10),
  minioAccessKey: process.env.MINIO_ACCESS_KEY!,
  minioSecretKey: process.env.MINIO_SECRET_KEY!,
  minioBucket: process.env.MINIO_BUCKET || 'streamtube',
  minioUseSsl: process.env.MINIO_USE_SSL === 'true',
  presignedUrlExpirySeconds: parseInt(
    process.env.PRESIGNED_URL_EXPIRY_SECONDS || '43200',
    10,
  ),
}));
