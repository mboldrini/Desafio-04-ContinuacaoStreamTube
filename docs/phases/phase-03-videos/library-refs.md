---
libs:
  "@nestjs/bullmq":
    version: "^11.x"
    fetched_at: "2026-09-08T00:00:00-03:00"
  bullmq:
    version: "^5.x"
    fetched_at: "2026-09-08T00:00:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    fetched_at: "2026-09-08T00:00:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    fetched_at: "2026-09-08T00:00:00-03:00"
  nanoid:
    version: "^3.x"
    fetched_at: "2026-09-08T00:00:00-03:00"
  fluent-ffmpeg:
    version: "^2.x"
    fetched_at: "2026-09-08T00:00:00-03:00"
  "@types/fluent-ffmpeg":
    version: "^2.x"
    fetched_at: "2026-09-08T00:00:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-08T00:00:00-03:00"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this phase. Covers APIs used in implementation of SIs 03.1–03.11.

---

## @nestjs/bullmq + bullmq

**Maps to:** `phase-03-videos/TD-01`

### Module registration

```typescript
// AppModule or VideosModule
import { BullModule } from '@nestjs/bullmq';
import { queueConfig } from '../config/queue.config';

BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.redisHost, port: cfg.redisPort },
  }),
}),

BullModule.registerQueueAsync({
  name: 'video-processing',
  inject: [queueConfig.KEY],
  useFactory: () => ({ defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } } }),
}),
```

### Injecting the queue producer

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

constructor(
  @InjectQueue('video-processing') private readonly videoQueue: Queue,
) {}

await this.videoQueue.add('process-video', { videoId, storageKey, channelId });
```

### Consumer (Processor)

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId, storageKey } = job.data;
    // ... processing logic
  }
}
```

### Worker bootstrap (no HTTP)

```typescript
// src/worker.ts
import { NestFactory } from '@nestjs/core';
import { VideosWorkerModule } from './videos/videos-worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(VideosWorkerModule);
  app.enableShutdownHooks();
}
bootstrap();
```

### Key contracts

- `@Processor('queue-name')` class must extend `WorkerHost` (v5+ API — not the v4 `process()` decorator pattern)
- `WorkerHost.process(job: Job<T>)` is the method overridden — no `@Process()` decorator needed in v5
- `@OnWorkerEvent('failed')` / `@OnWorkerEvent('completed')` for lifecycle hooks
- `BullModule.forRootAsync` must be imported in the worker module (not just the API module) for the processor to connect to Redis

---

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Maps to:** `phase-03-videos/TD-02`, `phase-03-videos/TD-06`

### S3Client initialization (MinIO-compatible)

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: `http://${cfg.minioEndpoint}:${cfg.minioPort}`,
  region: 'us-east-1',           // any value — MinIO ignores region
  credentials: {
    accessKeyId: cfg.minioAccessKey,
    secretAccessKey: cfg.minioSecretKey,
  },
  forcePathStyle: true,           // REQUIRED for MinIO — path-style: /{bucket}/{key}
});
```

### Presigned PUT URL (upload initiation)

```typescript
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const command = new PutObjectCommand({
  Bucket: cfg.minioBucket,
  Key: storageKey,
  ContentType: contentType,
});
const url = await getSignedUrl(s3, command, { expiresIn: cfg.presignedUrlExpirySeconds });
```

### HeadObject (verify upload completed)

```typescript
import { HeadObjectCommand, NotFound } from '@aws-sdk/client-s3';

try {
  await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return true; // object exists
} catch (err) {
  if (err instanceof NotFound) return false;
  throw err;
}
```

### GetObject with Range (streaming)

```typescript
import { GetObjectCommand } from '@aws-sdk/client-s3';

const command = new GetObjectCommand({
  Bucket: bucket,
  Key: key,
  Range: `bytes=${start}-${end}`,   // e.g., 'bytes=0-1048575'
});
const response = await s3.send(command);
// response.Body is a Readable stream — pipe to Express Response
(response.Body as Readable).pipe(res);
```

### PutObject (thumbnail upload from worker)

```typescript
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream } from 'fs';

await s3.send(new PutObjectCommand({
  Bucket: bucket,
  Key: thumbnailKey,
  Body: createReadStream(thumbnailLocalPath),
  ContentType: 'image/jpeg',
}));
```

### Key contracts

- `forcePathStyle: true` is **mandatory** for MinIO — without it the SDK uses virtual-hosted-style (`{bucket}.{endpoint}`) which MinIO does not support in local Docker setup
- `endpoint` must use the Docker Compose service name (`minio`), not `localhost`
- `region` can be any non-empty string — MinIO ignores it
- `response.Body` from `GetObjectCommand` is `SdkStreamMixin & Readable` — safe to pipe

---

## nanoid@3.x

**Maps to:** `phase-03-videos/TD-05`

### Version constraint

`nanoid@3.x` is the **last CJS-compatible release**. Version ≥5 is ESM-only and will fail to import in the project's CJS build output (`module: nodenext` without `"type": "module"` in `package.json`).

### Usage

```typescript
import { nanoid } from 'nanoid';

const uniqueId = nanoid(12);  // e.g., 'V1StGXR8_Z5j'
// Alphabet: A-Za-z0-9_- (URL-safe, no encoding needed)
```

### Collision probability

- 12-char alphabet (64 chars) = 64^12 ≈ 4.7 × 10^21 combinations
- At 1 billion videos: collision probability ≈ 0.000000021%
- DB unique constraint on `unique_id` column provides the final safety net (insert retry on conflict)

---

## fluent-ffmpeg

**Maps to:** `phase-03-videos/TD-04`

### System FFmpeg requirement

`fluent-ffmpeg` is a Node.js wrapper — it spawns the system `ffmpeg`/`ffprobe` binaries. In the worker Dockerfile:

```dockerfile
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
```

### FFprobe metadata extraction

```typescript
import ffmpeg from 'fluent-ffmpeg';
import { promisify } from 'util';

const ffprobeAsync = promisify(ffmpeg.ffprobe);

const metadata = await ffprobeAsync(localFilePath) as ffmpeg.FfprobeData;
const videoStream = metadata.streams.find(s => s.codec_type === 'video');
const duration = metadata.format.duration;         // seconds (float)
const width = videoStream?.width;
const height = videoStream?.height;
const codec = videoStream?.codec_name;
const bitrate = Number(metadata.format.bit_rate);  // bits/s
```

### Thumbnail generation

```typescript
await new Promise<void>((resolve, reject) => {
  ffmpeg(localFilePath)
    .screenshots({
      count: 1,
      timemarks: ['10%'],        // extract frame at 10% of duration
      filename: 'thumbnail.jpg',
      folder: tmpDir,
      size: '1280x720',
    })
    .on('end', () => resolve())
    .on('error', reject);
});
// thumbnail is at: path.join(tmpDir, 'thumbnail.jpg')
```

### Key contracts

- `ffprobe` must be available in `PATH` — guaranteed by `apt-get install ffmpeg` (includes ffprobe)
- Wrap callback-based API with `promisify` or `new Promise()` — do NOT use `.then()` chains
- Always clean up temp files in `finally` block — even on processing failure
- `timemarks: ['10%']` picks a representative frame, avoids black frames common at `0%`

---

## Temp file management (worker pattern)

The worker downloads the video from MinIO to a local temp file before processing. This is mandatory for 10GB files — in-memory streaming would OOM.

```typescript
import { tmpdir } from 'os';
import { join } from 'path';
import { createWriteStream, unlink } from 'fs';
import { promisify } from 'util';

const unlinkAsync = promisify(unlink);
const tmpPath = join(tmpdir(), `${videoId}-${Date.now()}.tmp`);

try {
  // 1. Download from MinIO to tmpPath
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
  await pipeline(response.Body as Readable, createWriteStream(tmpPath));

  // 2. Run ffprobe + ffmpeg on tmpPath
  // 3. Upload thumbnail
  // 4. Update DB
} finally {
  // Always clean up — even on error
  await unlinkAsync(tmpPath).catch(() => undefined);
  if (thumbnailPath) await unlinkAsync(thumbnailPath).catch(() => undefined);
}
```

`stream/promises.pipeline` is the correct Node.js API for piping streams with proper error propagation.
