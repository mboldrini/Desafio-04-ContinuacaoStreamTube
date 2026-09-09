# phase-03-videos — Progress

**Status:** complete
**SIs:** 11/11 implemented and verified

### SI-03.1 — Infrastructure: Dependencies, Config Namespaces, and Docker Compose
- **Status:** completed
- **Tests:** no tests (infra SI)
- **Observations:** Added MinIO + Redis to compose.yaml; storage.config.ts + queue.config.ts created; Joi validation extended with new required vars; package.json updated with @nestjs/bullmq@^11, bullmq@^5, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, nanoid@^3.3, fluent-ffmpeg; .env created; AppModule updated.

### SI-03.2 — Video Entity and Migration
- **Status:** completed
- **Tests:** videos.module.spec.ts (unit), video.entity.integration-spec.ts (integration) — all pass
- **Observations:** Migration 1788915102995-CreateVideos generated and applied; cleanAllTables updated to delete videos before channels (FK order); video.entity.integration-spec.ts fixed to call dataSource.initialize().

### SI-03.3 — Storage Module
- **Status:** completed
- **Tests:** storage.service.spec.ts (unit), storage.service.integration-spec.ts (integration) — all pass
- **Observations:** S3Client with forcePathStyle: true for MinIO; onModuleInit creates bucket; @Global() module.

### SI-03.4 — Queue Module
- **Status:** completed
- **Tests:** queue.module.spec.ts (unit) — passes
- **Observations:** BullMQ mock uses actual BullModule class with overridden static methods so NestJS export validation passes.

### SI-03.5 — Upload Initiation (POST /videos/upload-init)
- **Status:** implemented
- **Tests:** channels.service.spec.ts updated (findChannelByUserId); videos.service.spec.ts (unit); videos.service.integration-spec.ts (integration); test/videos.e2e-spec.ts (e2e)
- **Observations:** ChannelsService constructor now requires @InjectRepository(Channel) as 2nd arg; nanoid(12) for unique_id; storage_key pattern channels/{channelId}/videos/{videoId}/original; ConfigModule.forFeature(storageConfig) in VideosModule for presignedUrlExpirySeconds injection.

### SI-03.6 — Upload Completion (POST /videos/:id/complete)
- **Status:** implemented
- **Tests:** videos.service.spec.ts (unit); videos.service.integration-spec.ts (integration); test/videos.e2e-spec.ts (e2e)
- **Observations:** 5 new domain exceptions added (VideoNotFoundException, VideoNotOwnedException, VideoNotInDraftException, VideoFileNotInStorageException, VideoNotReadyException); queue.add(VIDEO_PROCESS_JOB, payload) after status='processing' save.

### SI-03.7 — Video Processor (Worker Consumer)
- **Status:** implemented
- **Tests:** video.processor.spec.ts (unit)
- **Observations:** @Processor(VIDEO_QUEUE) extends WorkerHost; ffprobe wraps Promise; ffmpeg screenshots with 10% timemark; putObjectFromStream for thumbnail; @OnWorkerEvent('failed') updates status='error'; temp files deleted in finally block; fluent-ffmpeg imported as default import due to export= type declaration.

### SI-03.8 — Worker Bootstrap and Docker Service
- **Status:** implemented
- **Tests:** no tests (infra SI)
- **Observations:** src/worker.ts bootstraps VideosWorkerModule via NestFactory.createApplicationContext; Dockerfile.worker.dev installs ffmpeg; video-worker service added to compose.yaml with env_file: .env; start:worker and start:worker:dev scripts added to package.json.

### SI-03.9 — Streaming Endpoint (GET /videos/:uniqueId/stream)
- **Status:** implemented
- **Tests:** videos.service.spec.ts (unit); test/videos.e2e-spec.ts (e2e)
- **Observations:** @Public() endpoint; @Res({ passthrough: false }) for manual pipe; Range header parsed as bytes={start}-{end}; 200 for full, 206 for partial; body.pipe(res).

### SI-03.10 — Download Endpoint (GET /videos/:uniqueId/download)
- **Status:** implemented
- **Tests:** videos.service.spec.ts (unit); test/videos.e2e-spec.ts (e2e)
- **Observations:** Content-Disposition: attachment with sanitized title (spaces→_, non-alphanumeric stripped); @Public() endpoint.

### SI-03.11 — TypeScript Compilation, Lint, and Definition of Done
- **Status:** completed
- **Tests:** 199/199 unit+integration, 70/70 e2e — all green
- **Observations:** Fixed 5 test bugs: (1) integration spec used string token `'StorageService'` instead of class reference; (2) `video.processor.spec.ts` `jest.mock('fs')` stripped `fs.promises`, breaking TypeORM import via path-scurry — fixed with `...jest.requireActual('fs')`; (3) dynamic `import()` in test body replaced with static import; (4) `videos.module.spec.ts` rewritten to use real DB + real Redis, with StorageService mocked; (5) e2e `--runInBand` missing from package.json causing FK violations from parallel DB writes. Also: `testTimeout: 30000` added to jest-e2e.json; controller now exposes `storage_key` in upload-init response for MinIO direct-upload in e2e tests.
