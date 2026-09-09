---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-08T00:00:00-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-05-12T13:36:17-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the complete video upload and processing pipeline: presigned URL–based upload of files up to 10GB (bypassing the API for data transfer), asynchronous video processing via BullMQ + FFmpeg (metadata extraction + thumbnail generation), unique URL per video via nanoid, API-proxied streaming with HTTP Range/206, and download support — with MinIO, Redis, and a dedicated video worker service running via Docker Compose.

---

## Step Implementations

### SI-03.1 — Infrastructure: Dependencies, Config Namespaces, and Docker Compose

**Description:** Install all Phase 03 production dependencies, create `storage`, `queue`, and `videos` config namespaces following the `registerAs` pattern from Phase 01, extend the Joi validation schema, and add MinIO and Redis services to Docker Compose.

**Technical actions:**

- Install production dependencies in `nestjs-project/`: `@nestjs/bullmq`, `bullmq`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `nanoid@3` (CJS-compatible version — see library-refs.md), `fluent-ffmpeg`
- Install dev dependencies: `@types/fluent-ffmpeg`
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading: `MINIO_ENDPOINT` (string, default `'minio'`), `MINIO_PORT` (number, default `9000`), `MINIO_ACCESS_KEY` (string, required), `MINIO_SECRET_KEY` (string, required), `MINIO_BUCKET` (string, default `'streamtube'`), `MINIO_USE_SSL` (boolean, default `false`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading: `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`)
- Update `src/config/env.validation.ts` — add all new vars to Joi schema: `MINIO_ACCESS_KEY` (required), `MINIO_SECRET_KEY` (required), `MINIO_ENDPOINT` (default `'minio'`), `MINIO_PORT` (default `9000`), `MINIO_BUCKET` (default `'streamtube'`), `MINIO_USE_SSL` (default `'false'`), `REDIS_HOST` (default `'redis'`), `REDIS_PORT` (default `6379`), `PRESIGNED_URL_EXPIRY_SECONDS` (default `43200` — 12 hours)
- Update `nestjs-project/.env.example` with new variables and Docker Compose–compatible defaults
- Add `minio` service to `nestjs-project/compose.yaml`: image `minio/minio:latest`, command `server /data --console-address :9001`, ports `9000:9000` (API) and `9001:9001` (console), environment `MINIO_ROOT_USER=streamtube` and `MINIO_ROOT_PASSWORD=streamtube`, healthcheck via `mc ready local`
- Add `redis` service to `nestjs-project/compose.yaml`: image `redis:7-alpine`, port `6379:6379`, healthcheck via `redis-cli ping`
- Update `nestjs-api` service in compose.yaml: add `depends_on` for `minio` and `redis`

**Dependencies:** None

**Acceptance criteria:**

- Application starts without errors when all new env vars are provided — existing E2E test (`GET /` returns 200) still passes
- Starting the application without `MINIO_ACCESS_KEY` causes a Joi validation error at bootstrap — the app does not start
- `docker compose up -d` starts MinIO, Redis, PostgreSQL, Mailpit, and nestjs-api without errors
- MinIO console is reachable at `localhost:9001`; Redis is pingable on port 6379

---

### SI-03.2 — Video Entity and Migration

**Description:** Create the `Video` entity with a many-to-one relation to `Channel`, generate the migration, and register `VideosModule` with `TypeOrmModule.forFeature([Video])` in `AppModule`.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns:
  - `id` (uuid PK generated)
  - `channel_id` (uuid, FK → channels.id, not null) — via `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })`
  - `title` (varchar(255), not null)
  - `status` (enum: `'draft'`, `'processing'`, `'ready'`, `'error'`; default `'draft'`, not null)
  - `unique_id` (varchar(20), unique, not null) — nanoid 12-char ID
  - `storage_key` (varchar(500), nullable) — MinIO object key set at upload initiation
  - `thumbnail_key` (varchar(500), nullable) — MinIO object key set by worker
  - `duration` (double precision, nullable) — seconds, from FFprobe
  - `file_size` (bigint, nullable) — bytes declared at upload-init
  - `mime_type` (varchar(100), nullable) — content_type declared at upload-init
  - `metadata` (jsonb, nullable) — full FFprobe output
  - `processing_error` (text, nullable) — worker error message when status = 'error'
  - `created_at` (CreateDateColumn)
  - `updated_at` (UpdateDateColumn)
- Create `src/videos/videos.module.ts` — `VideosModule` with `TypeOrmModule.forFeature([Video])` in imports; exports `TypeOrmModule` for use by the worker module
- Generate migration via `npm run migration:generate -- src/database/migrations/CreateVideos` and review the generated SQL for correct columns, enum type, indexes, and FK constraint
- Register `VideosModule` in `src/app.module.ts`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | unique_id unique constraint; status enum rejects invalid values; channel_id FK enforced; nullable fields accept null; timestamps auto-populated |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with TypeOrmModule.forFeature wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates `videos` table with all columns, the status enum type, and a unique index on `unique_id`
- Inserting a video with a duplicate `unique_id` fails with a unique constraint violation
- Inserting a video with an invalid status value fails with a PostgreSQL enum constraint violation
- Inserting a video with a non-existent `channel_id` fails with a FK constraint violation

---

### SI-03.3 — Storage Module

**Description:** Create `StorageModule` and `StorageService` wrapping `@aws-sdk/client-s3` for MinIO operations: presigned PUT URL generation, object existence check, object streaming (with optional Range), and raw object upload (for thumbnail from worker).

**Technical actions:**

- Create `src/storage/storage.module.ts` — `StorageModule` as a global module (`@Global()`) exporting `StorageService`, with `ConfigModule` in imports so `storageConfig` injection works. Implements `OnModuleInit` to ensure the MinIO bucket exists (create if absent via `CreateBucketCommand` + catch `BucketAlreadyOwnedByYou` and `BucketAlreadyExists` errors)
- Create `src/storage/storage.service.ts` — `StorageService` injecting `storageConfig`:
  - Initializes `S3Client` with `endpoint`, `region: 'us-east-1'`, `credentials`, and `forcePathStyle: true` (required for MinIO — see library-refs.md)
  - `createPresignedPutUrl(key: string, contentType: string, expiresIn: number): Promise<string>` — `PutObjectCommand` + `getSignedUrl`
  - `objectExists(key: string): Promise<boolean>` — `HeadObjectCommand`; returns `false` on `NotFound`, re-throws other errors
  - `getObjectStream(key: string, range?: string): Promise<{ body: Readable; contentLength: number; contentType: string }>` — `GetObjectCommand` with optional `Range` header; extracts `ContentLength` and `ContentType` from response; returns `response.Body as Readable`
  - `putObjectFromStream(key: string, body: Readable, contentType: string): Promise<void>` — `PutObjectCommand` with stream body (used by worker for thumbnail upload)
  - `getObjectSize(key: string): Promise<number>` — `HeadObjectCommand` returning `ContentLength`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.spec.ts` | Unit | `createPresignedPutUrl` passes correct Bucket/Key/ContentType to SDK; `objectExists` returns false on NotFound; `getObjectStream` includes Range in command when provided; S3Client initialized with `forcePathStyle: true` |
| `src/storage/storage.service.integration-spec.ts` | Integration | Bucket auto-created if absent; `objectExists` returns false for missing key; after uploading a small object, `objectExists` returns true and `getObjectStream` returns the body |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `StorageService` initializes the S3Client with `forcePathStyle: true` and the MinIO endpoint from config
- On module init, the configured bucket exists in MinIO (created if absent)
- `createPresignedPutUrl` returns a URL that accepts a PUT request directly to MinIO (verifiable in integration test)
- `objectExists` returns `false` for a non-existent key and `true` after the object is created
- `getObjectStream` returns a readable stream for an existing object; with a Range string, fetches only the specified bytes

---

### SI-03.4 — Queue Module

**Description:** Configure `BullModule.forRootAsync` with Redis and register the `video-processing` queue. Export `QueueModule` for use in `VideosModule` and `VideosWorkerModule`.

**Technical actions:**

- Create `src/queue/queue.constants.ts` — export `VIDEO_QUEUE = 'video-processing'` and `VIDEO_PROCESS_JOB = 'process-video'` as `const` strings
- Create `src/queue/queue.module.ts` — `QueueModule` importing:
  - `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.redisHost, port: cfg.redisPort } }) })`
  - `BullModule.registerQueueAsync({ name: VIDEO_QUEUE, useFactory: () => ({ defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 100, removeOnFail: 50 } }) })`
  - `ConfigModule` in imports (so `queueConfig.KEY` resolves)
  - Exports both `BullModule` registrations

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/queue.module.spec.ts` | Unit | Module compiles with BullModule.forRootAsync and registerQueueAsync wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `QueueModule` compiles and registers the `video-processing` BullMQ queue
- `VIDEO_QUEUE` constant matches the queue name used in `@InjectQueue(VIDEO_QUEUE)` and `@Processor(VIDEO_QUEUE)`

---

### SI-03.5 — Upload Initiation (POST /videos/upload-init)

**Description:** Implement the upload initiation endpoint: create a draft video record (with nanoid unique_id and a pre-determined storage key), generate a presigned PUT URL via StorageService, and return both to the client. Auth is required — the channel is derived from the authenticated user.

**Technical actions:**

- Create `src/videos/dto/initiate-upload.dto.ts` — `InitiateUploadDto` with:
  - `@IsString() @IsNotEmpty() @MaxLength(255)` title (required)
  - `@IsString() @IsNotEmpty() @Matches(/^video\//)` content_type (required, must be a `video/*` MIME type)
  - `@IsInt() @Min(1) @Max(10737418240)` file_size (required, bytes; max 10GB = 10 × 1024³)
- Create `src/videos/videos.service.ts` — `VideosService` injecting `Repository<Video>`, `StorageService`, `ChannelsService`, `@InjectQueue(VIDEO_QUEUE) videoQueue: Queue`:
  - `initiateUpload(userId: string, dto: InitiateUploadDto): Promise<{ video: Video; uploadUrl: string; expiresAt: Date }>`:
    1. Find channel by `userId` via `channelsService.findChannelByUserId(userId)` (add this method to `ChannelsService`)
    2. Generate `videoId = crypto.randomUUID()`
    3. Generate `uniqueId = nanoid(12)` (import from `nanoid`)
    4. Build `storageKey = channels/${channel.id}/videos/${videoId}/original`
    5. Call `storageService.createPresignedPutUrl(storageKey, dto.content_type, presignedExpirySeconds)`
    6. Compute `expiresAt = new Date(Date.now() + presignedExpirySeconds * 1000)`
    7. Save Video with `{ id: videoId, channel_id: channel.id, title: dto.title, unique_id: uniqueId, storage_key: storageKey, file_size: dto.file_size, mime_type: dto.content_type, status: 'draft' }`
    8. Return `{ video, uploadUrl, expiresAt }`
  - Add `findChannelByUserId(userId: string): Promise<Channel>` to `ChannelsService` (inject `Repository<Channel>`, find by `user_id`)
- Create `src/videos/videos.controller.ts` — `VideosController` with prefix `'videos'`:
  - `@Post('upload-init')` — auth required (global guard), calls `videosService.initiateUpload(@CurrentUser().sub, dto)`, returns 201 with `{ video: { id, unique_id, channel_id, title, status, created_at }, upload_url, expires_at }`
- Update `src/videos/videos.module.ts` — import `StorageModule`, `QueueModule`, `ChannelsModule`, `ConfigModule`; provide `VideosService`, `VideosController`
- Inject `storageConfig` for `PRESIGNED_URL_EXPIRY_SECONDS` into `VideosService`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `initiateUpload`: finds channel by userId; generates unique_id (nanoid); builds correct storage_key; calls `createPresignedPutUrl`; saves video with status='draft'; returns video + uploadUrl + expiresAt |
| `src/channels/channels.service.spec.ts` | Unit | `findChannelByUserId` returns channel for known userId, throws on unknown userId |
| `src/videos/videos.service.integration-spec.ts` | Integration | `initiateUpload` persists Video in DB with correct channel_id, unique_id, status='draft', mime_type, file_size; storage_key follows `channels/{channelId}/videos/{videoId}/original` pattern |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/upload-init` 201 with `{ video, upload_url, expires_at }`; 400 on invalid body (missing title, wrong content_type format, file_size > 10GB); 401 without auth |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos/upload-init` with valid auth and body returns 201 with `{ video: { id, unique_id, channel_id, title, status: 'draft', created_at }, upload_url, expires_at }`
- The `upload_url` is a presigned PUT URL pointing to MinIO — a direct PUT to that URL with the video bytes succeeds
- `POST /videos/upload-init` without an Authorization header returns 401
- `POST /videos/upload-init` with `content_type: 'application/pdf'` returns 400 (fails `@Matches(/^video\//)`)
- `POST /videos/upload-init` with `file_size > 10737418240` returns 400
- The video record in the DB has `status = 'draft'` and `unique_id` of exactly 12 URL-safe characters

---

### SI-03.6 — Upload Completion (POST /videos/:id/complete)

**Description:** Implement the upload completion endpoint: verify ownership, verify the object exists in MinIO (the actual upload was performed), transition status to `processing`, and enqueue the video processing job.

**Technical actions:**

- Add domain exceptions to `src/common/exceptions/domain.exception.ts`:
  - `VideoNotFoundException` — `errorCode: 'VIDEO_NOT_FOUND'`, `httpStatus: 404`
  - `VideoNotOwnedException` — `errorCode: 'VIDEO_NOT_OWNED'`, `httpStatus: 403`
  - `VideoNotInDraftException` — `errorCode: 'VIDEO_NOT_IN_DRAFT'`, `httpStatus: 409`
  - `VideoFileNotInStorageException` — `errorCode: 'VIDEO_FILE_NOT_IN_STORAGE'`, `httpStatus: 422`
  - `VideoNotReadyException` — `errorCode: 'VIDEO_NOT_READY'`, `httpStatus: 422`
- Implement `completeUpload(videoId: string, userId: string): Promise<Video>` in `VideosService`:
  1. Find video by `id` — throw `VideoNotFoundException` if not found
  2. Find channel by `userId` — verify `video.channel_id === channel.id`, throw `VideoNotOwnedException` if mismatch
  3. If `video.status !== 'draft'` — throw `VideoNotInDraftException`
  4. Call `storageService.objectExists(video.storage_key)` — throw `VideoFileNotInStorageException` if false
  5. Update video: `status = 'processing'`; save
  6. Enqueue: `videoQueue.add(VIDEO_PROCESS_JOB, { videoId: video.id, storageKey: video.storage_key, channelId: video.channel_id })`
  7. Return updated video
- Add `@Post(':id/complete')` to `VideosController` — auth required, `@HttpCode(202)`, returns `{ video: { id, unique_id, channel_id, title, status, updated_at } }`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `completeUpload`: video not found throws; not owner throws; not draft throws; file not in storage throws; success path: status='processing', job enqueued with correct payload |
| `src/videos/videos.service.integration-spec.ts` | Integration | `completeUpload` persists status='processing' in DB; BullMQ job enqueued (verify via queue.getJobCounts()) |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/:id/complete` 202; 401 no auth; 403 not owner; 409 already processing; 422 file not in MinIO; 404 unknown video id |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `POST /videos/:id/complete` with valid auth and a video in `draft` status whose `storage_key` exists in MinIO returns 202 with `{ video: { ..., status: 'processing' } }`
- The BullMQ `video-processing` queue has 1 job with payload `{ videoId, storageKey, channelId }` after a successful completion
- `POST /videos/:id/complete` with a video belonging to another user returns 403 with `VIDEO_NOT_OWNED`
- `POST /videos/:id/complete` for a video already in `processing` status returns 409 with `VIDEO_NOT_IN_DRAFT`
- `POST /videos/:id/complete` when the MinIO object does not exist returns 422 with `VIDEO_FILE_NOT_IN_STORAGE`
- `POST /videos/:id/complete` with an unknown UUID returns 404 with `VIDEO_NOT_FOUND`

---

### SI-03.7 — Video Processor (Worker Consumer)

**Description:** Implement the BullMQ consumer that processes `process-video` jobs: download the video from MinIO to a local temp file, run FFprobe for metadata, run FFmpeg for thumbnail generation, upload the thumbnail to MinIO, and update the video record (status + metadata). On failure, mark the video with `status = 'error'` and `processing_error`.

**Technical actions:**

- Create `src/videos/processors/video.processor.ts` — `@Processor(VIDEO_QUEUE)` class extending `WorkerHost`:
  - Injects: `@InjectRepository(Video) Repository<Video>`, `StorageService`, (no ChannelsService needed — channelId is in job payload)
  - `async process(job: Job<ProcessVideoJobData>): Promise<void>`:
    1. Declare `tmpVideoPath = join(tmpdir(), '${job.data.videoId}-${Date.now()}.tmp')` and `tmpThumbPath`; wrap all in `try/finally` to delete both temp files
    2. **Download:** `storageService.getObjectStream(storageKey)` → pipe `response.body` to `createWriteStream(tmpVideoPath)` using `stream/promises.pipeline`
    3. **Metadata:** `ffprobe(tmpVideoPath)` → extract `format.duration`, `format.bit_rate`, `streams[0].width`, `streams[0].height`, `streams[0].codec_name`; store full metadata object
    4. **Thumbnail:** compute `tmpThumbDir = tmpdir()`, `tmpThumbPath = join(tmpThumbDir, '${job.data.videoId}-thumb.jpg')`; run `ffmpeg(tmpVideoPath).screenshots({ count: 1, timemarks: ['10%'], filename: '${job.data.videoId}-thumb.jpg', folder: tmpThumbDir, size: '1280x720' })`
    5. **Upload thumbnail:** `storageService.putObjectFromStream(thumbnailKey, createReadStream(tmpThumbPath), 'image/jpeg')` where `thumbnailKey = channels/${channelId}/videos/${videoId}/thumbnail.jpg`
    6. **Update video:** `videoRepository.update(videoId, { status: 'ready', duration: metadata.format.duration, metadata: fullMetadata, thumbnail_key: thumbnailKey })`
  - On any unhandled error in the `process()` method (caught by BullMQ after exhausting retries via `@OnWorkerEvent('failed')`): update video `{ status: 'error', processing_error: job.failedReason ?? err.message }`
  - Decorate with `@OnWorkerEvent('failed')` to catch the final failure and update DB
- Create `src/videos/videos-worker.module.ts` — `VideosWorkerModule` (for the worker bootstrap):
  - Imports: `ConfigModule.forRoot({ isGlobal: true, load: [storageConfig, queueConfig, databaseConfig] })`, `TypeOrmModule.forRootAsync(...)`, `TypeOrmModule.forFeature([Video])`, `StorageModule`, `QueueModule`
  - Providers: `VideoProcessor`
  - No HTTP server; no AuthModule; no MailModule

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processors/video.processor.spec.ts` | Unit | Success path: downloads to temp, ffprobe extracts duration, ffmpeg generates thumbnail, thumbnail uploaded, video updated status='ready'; Failure path: on ffprobe error, video updated status='error' with error message; temp files cleaned up in both paths (unlink called in finally) |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- `VideoProcessor.process()` downloads the video to a temp file, runs FFprobe and FFmpeg, uploads the thumbnail, and updates the video record with `status = 'ready'`, `duration`, `metadata`, `thumbnail_key`
- If FFprobe or FFmpeg fails, the job throws — BullMQ retries up to 3 times (exponential backoff, 5s base delay)
- After all retries exhausted, `@OnWorkerEvent('failed')` updates the video: `status = 'error'`, `processing_error = job.failedReason`
- Temp files (`tmpVideoPath`, `tmpThumbPath`) are deleted in the `finally` block regardless of success or failure

---

### SI-03.8 — Worker Bootstrap and Docker Service

**Description:** Create the NestJS application context bootstrap for the worker process (`src/worker.ts`) and a dedicated `Dockerfile.worker.dev` that installs FFmpeg. Add `video-worker` to `compose.yaml`.

**Technical actions:**

- Create `nestjs-project/src/worker.ts`:
  ```typescript
  import 'reflect-metadata';
  import { NestFactory } from '@nestjs/core';
  import { VideosWorkerModule } from './videos/videos-worker.module';

  async function bootstrap() {
    const app = await NestFactory.createApplicationContext(VideosWorkerModule, {
      logger: ['log', 'warn', 'error'],
    });
    app.enableShutdownHooks();
  }
  void bootstrap();
  ```
- Create `nestjs-project/Dockerfile.worker.dev`:
  ```dockerfile
  FROM node:22-bookworm-slim
  RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
  WORKDIR /home/node/app
  CMD ["node", "dist/worker.js"]
  ```
- Add `video-worker` service to `nestjs-project/compose.yaml`:
  - `build: { context: ., dockerfile: Dockerfile.worker.dev }`
  - `volumes: [".:/home/node/app"]` (same volume as nestjs-api — shared compiled output)
  - `depends_on: { db: { condition: service_healthy }, redis: { condition: service_healthy }, minio: { condition: service_healthy } }`
  - `env_file: .env`
- Update `nest-cli.json` — add `worker` to entrypoints if using multiple builds, OR rely on `tsc` compiling `src/worker.ts` as part of the standard build (it already would since it's in `src/`)
- Add `"start:worker": "node dist/worker.js"` and `"start:worker:dev": "nest start --watch --entryFile worker"` to `package.json` scripts (for local non-Docker execution)
- The `nestjs-api` service does NOT depend on `video-worker` — the worker is a consumer, not a dependency of the API

**Tests:**

None (infrastructure SI). Verified by:

```bash
docker compose up -d
docker compose logs video-worker   # expect: "NestFactory worker connected"
docker compose exec db psql -U streamtube -c "SELECT status FROM videos WHERE id = '<processed-id>'"
```

**Dependencies:** SI-03.1, SI-03.7

**Acceptance criteria:**

- `docker compose up -d` starts `video-worker` alongside `nestjs-api`, `db`, `redis`, `minio`, and `mailpit`
- The worker container has FFmpeg available: `docker compose exec video-worker ffmpeg -version` exits 0
- The worker process connects to Redis and BullMQ without errors (visible in `docker compose logs video-worker`)
- When a `process-video` job is enqueued (via `POST /videos/:id/complete`), the worker picks it up and processes it — verifiable by checking video status transitions in DB

---

### SI-03.9 — Streaming Endpoint (GET /videos/:uniqueId/stream)

**Description:** Implement the video streaming endpoint that proxies byte-range requests from MinIO to the client, supporting 200 (full file) and 206 (partial content) responses. Endpoint is public — no auth required.

**Technical actions:**

- Implement `findByUniqueId(uniqueId: string): Promise<Video>` in `VideosService` — find by `unique_id`, throw `VideoNotFoundException` if not found
- Implement `streamVideo(uniqueId: string, rangeHeader: string | undefined, res: Response): Promise<void>` in `VideosService`:
  1. Find video via `findByUniqueId(uniqueId)`
  2. If `video.status !== 'ready'` → throw `VideoNotReadyException`
  3. Get total size: `await storageService.getObjectSize(video.storage_key)`
  4. Parse `rangeHeader`:
     - If absent: serve full object → `getObjectStream(storageKey)`, set `Content-Type: video.mime_type`, `Accept-Ranges: bytes`, `Content-Length: totalSize`, status 200, pipe body to `res`
     - If present: parse `bytes={start}-{end?}` → default `end = totalSize - 1` if absent; validate `start <= end < totalSize`; compute `chunkSize = end - start + 1`; call `getObjectStream(storageKey, 'bytes=${start}-${end}')`, set `Content-Type: video.mime_type`, `Accept-Ranges: bytes`, `Content-Range: bytes ${start}-${end}/${totalSize}`, `Content-Length: chunkSize`, status 206, pipe body to `res`
- Add `@Get(':uniqueId/stream')` to `VideosController` — `@Public()`, no `@Res()` return value (res passed directly to service for streaming), method returns `void`
- Inject `@Res({ passthrough: false }) res: Response` in the handler; call `videosService.streamVideo(uniqueId, req.headers.range, res)`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `streamVideo`: video not found throws; status not ready throws; no Range header → full stream (200); Range header → partial stream (206) with correct Content-Range; res.status() and res.set() called with correct values |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:uniqueId/stream` 200 for full object (no Range); 206 for `Range: bytes=0-1023`; 404 for unknown uniqueId; 422 for draft/processing video; returns `Content-Type: video/mp4`; 206 response has `Content-Range` header |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `GET /videos/:uniqueId/stream` without a `Range` header returns 200 with the full video body and `Accept-Ranges: bytes`
- `GET /videos/:uniqueId/stream` with `Range: bytes=0-1023` returns 206 with `Content-Range: bytes 0-1023/{total}` and 1024 bytes of video data
- `GET /videos/:uniqueId/stream` for an unknown unique_id returns 404 with `VIDEO_NOT_FOUND`
- `GET /videos/:uniqueId/stream` for a video in `processing` or `draft` status returns 422 with `VIDEO_NOT_READY`
- Streaming does not buffer the entire video in API memory — the response body is piped from MinIO

---

### SI-03.10 — Download Endpoint (GET /videos/:uniqueId/download)

**Description:** Implement the download endpoint that serves the video with a `Content-Disposition: attachment` header, triggering a browser file download. Reuses the same MinIO proxy approach as the streaming endpoint. Endpoint is public.

**Technical actions:**

- Implement `downloadVideo(uniqueId: string, res: Response): Promise<void>` in `VideosService`:
  1. Find video via `findByUniqueId(uniqueId)` — throw `VideoNotFoundException` if not found
  2. If `video.status !== 'ready'` → throw `VideoNotReadyException`
  3. Get total size via `storageService.getObjectSize(video.storage_key)`
  4. Get object stream (full — no Range): `storageService.getObjectStream(video.storage_key)`
  5. Set headers: `Content-Type: video.mime_type`, `Content-Disposition: attachment; filename="${sanitizedTitle}.mp4"` (sanitize title: strip non-ASCII, replace spaces with `_`, fallback to `video`), `Content-Length: totalSize`, `Accept-Ranges: bytes`
  6. Status 200, pipe body to `res`
- Add `@Get(':uniqueId/download')` to `VideosController` — `@Public()`, same `@Res()` pattern as streaming

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `downloadVideo`: not found throws; not ready throws; sets Content-Disposition: attachment header |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:uniqueId/download` 200 with `Content-Disposition: attachment; filename=...`; 404 for unknown; 422 for not ready |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- `GET /videos/:uniqueId/download` returns 200 with `Content-Disposition: attachment` header causing a browser file download
- The filename in `Content-Disposition` is derived from the video's title (ASCII-safe)
- `GET /videos/:uniqueId/download` for an unknown unique_id returns 404 with `VIDEO_NOT_FOUND`
- `GET /videos/:uniqueId/download` for a non-ready video returns 422 with `VIDEO_NOT_READY`

---

### SI-03.11 — TypeScript Compilation, Lint, and Definition of Done

**Description:** Ensure zero TypeScript compilation errors, passing lint, and a fully green test suite across all levels (unit, integration, e2e).

**Technical actions:**

- Run `npx tsc --noEmit` — fix any errors introduced in Phase 03 (common causes: missing `import type`, untyped `response.Body`, incorrect async return types)
- Run `npm run lint` — fix any ESLint violations
- Run `npm test -- --runInBand` — all unit and integration tests must pass
- Run `npm run test:e2e` — all e2e tests must pass
- Verify migrations runner integration test still passes (add Video to the entities list in `migrations.integration-spec.ts` if needed)
- Update `src/database/migrations.integration-spec.ts` to include `Video` entity in the DataSource entities array and assert the `videos` table exists after `runMigrations()`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/database/migrations.integration-spec.ts` | Integration | `runMigrations()` includes `CreateVideos` migration; `videos` table exists after run |

**Dependencies:** SI-03.1 through SI-03.10

**Acceptance criteria:**

- `npx tsc --noEmit` exits with code 0 — zero type errors
- `npm run lint` exits with code 0
- `npm test -- --runInBand` reports all tests passing
- `npm run test:e2e` reports all tests passing
- All video-related tests (unit, integration, e2e) are green

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| channel_id | uuid | FK → channels.id, not null | Many-to-one; `@ManyToOne(() => Channel)` |
| title | varchar(255) | not null | Provided at upload initiation |
| status | enum | not null, default `'draft'` | Values: `'draft'`, `'processing'`, `'ready'`, `'error'` |
| unique_id | varchar(20) | unique, not null | nanoid 12-char URL-safe ID |
| storage_key | varchar(500) | nullable | MinIO object key: `channels/{channelId}/videos/{videoId}/original` |
| thumbnail_key | varchar(500) | nullable | Set by worker: `channels/{channelId}/videos/{videoId}/thumbnail.jpg` |
| duration | double precision | nullable | Seconds (float), from FFprobe `format.duration` |
| file_size | bigint | nullable | Bytes declared at upload-init |
| mime_type | varchar(100) | nullable | content_type from upload-init DTO |
| metadata | jsonb | nullable | Full FFprobe metadata object |
| processing_error | text | nullable | Last worker error message; set when status = `'error'` |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, `channel_id` FK, owning side)

**Indexes:**
- `(unique_id)` — unique, used for streaming/download lookups
- `(channel_id)` — FK index (TypeORM generates automatically)
- `(status)` — for filtering by status

**Key invariants:**
- `storage_key` is always set at record creation (draft); it never changes.
- `thumbnail_key` is null until the worker successfully processes the video.
- Once `status = 'ready'`, all of `duration`, `metadata`, `thumbnail_key` are non-null.
- Once `status = 'error'`, `processing_error` is non-null.

---

### API Contracts

#### POST /videos/upload-init (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- title: string, required — max 255 chars; video title
- content_type: string, required — must match `^video/` (e.g., `video/mp4`, `video/webm`)
- file_size: integer, required — bytes; min 1, max 10,737,418,240 (10GB)

**Response 201:**
```json
{
  "video": {
    "id": "uuid",
    "unique_id": "abc123def456",
    "channel_id": "uuid",
    "title": "My Video",
    "status": "draft",
    "created_at": "2026-09-08T00:00:00.000Z"
  },
  "upload_url": "http://minio:9000/streamtube/channels/.../original?X-Amz-Signature=...",
  "expires_at": "2026-09-08T12:00:00.000Z"
}
```

**Error responses:**
- 401: no auth
- 400 VALIDATION_ERROR: invalid body (bad content_type, file_size > 10GB, missing title)

---

#### POST /videos/:id/complete (SI-03.6)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Request body:** none

**Response 202:**
```json
{
  "video": {
    "id": "uuid",
    "unique_id": "abc123def456",
    "channel_id": "uuid",
    "title": "My Video",
    "status": "processing",
    "updated_at": "2026-09-08T00:01:00.000Z"
  }
}
```

**Error responses:**
- 401: no auth
- 403 VIDEO_NOT_OWNED: authenticated user's channel does not own this video
- 404 VIDEO_NOT_FOUND: video with given `id` not found
- 409 VIDEO_NOT_IN_DRAFT: video is not in `draft` status
- 422 VIDEO_FILE_NOT_IN_STORAGE: MinIO object for `storage_key` does not exist

---

#### GET /videos/:uniqueId/stream (SI-03.9)

**Request headers:**
- Range: `bytes={start}-{end}` (optional)

**Response 200** (no Range header — full object):
- Content-Type: `{video.mime_type}` (e.g., `video/mp4`)
- Accept-Ranges: `bytes`
- Content-Length: `{totalSize}`
- Body: full video bytes

**Response 206** (Range header — partial content):
- Content-Type: `{video.mime_type}`
- Accept-Ranges: `bytes`
- Content-Range: `bytes {start}-{end}/{total}`
- Content-Length: `{chunkSize}`
- Body: requested byte range

**Error responses:**
- 404 VIDEO_NOT_FOUND: no video with this unique_id
- 422 VIDEO_NOT_READY: video exists but status ≠ `'ready'`

---

#### GET /videos/:uniqueId/download (SI-03.10)

**Response 200:**
- Content-Type: `{video.mime_type}`
- Content-Disposition: `attachment; filename="{sanitized-title}.mp4"`
- Content-Length: `{totalSize}`
- Accept-Ranges: `bytes`
- Body: full video bytes

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 422 VIDEO_NOT_READY

---

#### Validation Rules

| Field | Rule | Error |
|-------|------|-------|
| title | required, max 255 chars | must not be empty / too long |
| content_type | must match `^video/` | content_type must be a video MIME type |
| file_size | integer, min 1, max 10,737,418,240 | must be between 1 and 10GB |

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Channel Owner | Notes |
|----------|--------|---------------|---------------|-------|
| POST /videos/upload-init | | ✓ | ✓ | Channel derived from JWT `sub` → users.channel |
| POST /videos/:id/complete | | ✓ | ✓ | video.channel_id must match user's channel |
| GET /videos/:uniqueId/stream | ✓ | | | No auth required — anyone can stream |
| GET /videos/:uniqueId/download | ✓ | | | No auth required — anyone can download |

---

### Error Catalog

_Extends the Phase 02 error catalog. Format inherited: `{ statusCode, error, message }`_

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | GET stream/download or POST complete with unknown id/unique_id |
| VIDEO_NOT_OWNED | 403 | You do not own this video | POST /videos/:id/complete by a user whose channel ≠ video.channel_id |
| VIDEO_NOT_IN_DRAFT | 409 | Video is not in draft status | POST /videos/:id/complete when status ≠ 'draft' |
| VIDEO_FILE_NOT_IN_STORAGE | 422 | Video file not found in storage | POST /videos/:id/complete when MinIO object does not exist |
| VIDEO_NOT_READY | 422 | Video is not ready for playback | GET stream/download when status ≠ 'ready' |

---

### Events / Messages (Queue)

**Queue name:** `video-processing` (constant: `VIDEO_QUEUE`)

**Job name:** `process-video` (constant: `VIDEO_PROCESS_JOB`)

**Producer:** `VideosService.completeUpload()` — enqueues after status transition to `'processing'`

**Consumer:** `VideoProcessor` in the `video-worker` Docker service

#### Job Payload (ProcessVideoJobData)

```typescript
interface ProcessVideoJobData {
  videoId: string;    // uuid — Video.id
  storageKey: string; // MinIO object key — Video.storage_key
  channelId: string;  // uuid — Video.channel_id (for building thumbnailKey)
}
```

#### Job Lifecycle

| State | Description |
|-------|-------------|
| `waiting` | Job enqueued; no worker has picked it up yet |
| `active` | Worker is executing `process()` |
| `completed` | `process()` resolved; video updated to `status='ready'` |
| `failed` | `process()` threw; BullMQ will retry (up to 3 attempts total) |

#### Retry Configuration

```typescript
{
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s
  removeOnComplete: 100, // keep last 100 completed jobs for debugging
  removeOnFail: 50,      // keep last 50 failed jobs for inspection
}
```

#### Worker Success Outcome

After `process()` resolves:
- Video updated: `{ status: 'ready', duration, metadata (jsonb), thumbnail_key }`
- Temp files deleted from worker container filesystem

#### Worker Failure Outcome (after all retries)

Via `@OnWorkerEvent('failed')`:
- Video updated: `{ status: 'error', processing_error: job.failedReason }`
- Temp files deleted from worker container filesystem (via finally block)

---

## Dependency Map

```
SI-03.1 (no deps — infra baseline)
├── SI-03.2 (entity + migration)
├── SI-03.3 (storage module)
└── SI-03.4 (queue module)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5 (upload initiation)
    └── SI-03.6 (upload completion)
        └── SI-03.7 (video processor)

SI-03.1 + SI-03.7
└── SI-03.8 (worker bootstrap + Docker service)

SI-03.2 + SI-03.3
└── SI-03.9 (streaming endpoint)
    └── SI-03.10 (download endpoint)

SI-03.5 + SI-03.6 + SI-03.7 + SI-03.8 + SI-03.9 + SI-03.10
└── SI-03.11 (TypeScript, lint, DoD)
```

**Linearized implementation order:**

SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (parallel) → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8; SI-03.9 can start as soon as SI-03.2 + SI-03.3 complete → SI-03.10 → SI-03.11 (after all prior SIs complete)

---

## Deliverables

- [ ] MinIO and Redis services added to `nestjs-project/compose.yaml`; `video-worker` service added with `Dockerfile.worker.dev` (FFmpeg installed)
- [ ] `storage`, `queue` config namespaces created in `src/config/`; Joi schema updated; `.env.example` updated
- [ ] Video entity created with `unique_id`, `status` enum (draft/processing/ready/error), FK to channels, and all processing fields
- [ ] Migration `CreateVideos` creates `videos` table with correct columns, enum, indexes, and FK constraint
- [ ] `StorageModule` / `StorageService` wrapping @aws-sdk/client-s3 with `forcePathStyle: true` for MinIO
- [ ] `QueueModule` configuring BullMQ + Redis with `VIDEO_QUEUE = 'video-processing'`
- [ ] `POST /videos/upload-init` creates draft video + returns presigned PUT URL (direct to MinIO, 12h expiry)
- [ ] `POST /videos/:id/complete` verifies MinIO object exists, transitions to `processing`, enqueues `process-video` job
- [ ] `VideoProcessor` downloads video to temp file, runs FFprobe + FFmpeg, uploads thumbnail, updates video to `ready` (or `error` after 3 retries)
- [ ] `src/worker.ts` bootstraps `VideosWorkerModule` without HTTP server
- [ ] `GET /videos/:uniqueId/stream` supports full (200) and range (206) streaming via API proxy — MinIO not exposed to client
- [ ] `GET /videos/:uniqueId/download` returns full video with `Content-Disposition: attachment`
- [ ] Video status lifecycle (`draft → processing → ready | error`) reflected in DB and enforced by API (409 on wrong state)
- [ ] Domain error codes `VIDEO_NOT_FOUND`, `VIDEO_NOT_OWNED`, `VIDEO_NOT_IN_DRAFT`, `VIDEO_FILE_NOT_IN_STORAGE`, `VIDEO_NOT_READY` added to error catalog and `DomainException` subclasses
- [ ] Unit tests for `VideosService`, `StorageService`, `VideoProcessor` passing
- [ ] Integration tests for Video entity, `VideosService`, `StorageService` (real MinIO) passing
- [ ] E2E tests for all four endpoints (`upload-init`, `complete`, `stream`, `download`) passing
- [ ] Migration runner integration test includes `CreateVideos` and `videos` table assertion
- [ ] `npx tsc --noEmit` exits with code 0
- [ ] `npm run lint` exits with code 0
- [ ] `npm test -- --runInBand` all passing
- [ ] `npm run test:e2e` all passing
