---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-08
scope_description: "Video upload pipeline: object storage usage, 10GB upload strategy without blocking the API, queue technology (TBD in project plan), async video worker, FFmpeg processing, unique video URL, streaming strategy, and video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — Backend API delivering video upload initiation, completion notification, streaming, and download endpoints; plus Docker infrastructure for object storage, message queue, and video worker.

---

## TD-01: Queue Technology

**Scope:** Backend + Infrastructure

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan explicitly marks the queue technology as "TBD". A message queue is required to decouple the video upload completion event from the heavy processing work (FFprobe metadata extraction + FFmpeg thumbnail generation). The queue must persist jobs across restarts, support retries on failure, and integrate cleanly with NestJS.

**Options:**

### Option A: BullMQ with Redis (@nestjs/bullmq)
- BullMQ is the successor to Bull, built on Redis Streams. The NestJS team publishes `@nestjs/bullmq` as an official integration module. Jobs are persisted in Redis and survive restarts. Supports retry strategies, job priority, concurrency limits, and delayed jobs. Bull Board provides an optional dashboard.
- **Pros:** First-class NestJS module (`BullModule.forRootAsync`, `@Processor`, `@OnWorkerEvent`). Redis is a single-service addition that is already common in Node.js stacks. Excellent TypeScript support and active community. Job state machine (waiting → active → completed/failed) is built-in. Retries with configurable backoff.
- **Cons:** Requires Redis as an additional infrastructure service. Redis is ephemeral by default (jobs lost if Redis data is wiped without persistence config). For truly durable messaging (guaranteed delivery), a broker like RabbitMQ is stronger.

### Option B: RabbitMQ with AMQP (amqplib / @nestjs-modules/rabbitmq)
- A traditional message broker with durable queues, exchanges, routing keys, and acknowledgements. Durable queues survive broker restarts even without extra config.
- **Pros:** Protocol-level durability. Native dead-letter queues and message TTL. Good for multi-consumer fan-out patterns. Well-understood operations model.
- **Cons:** No official NestJS module — requires `@golevelup/nestjs-rabbitmq` (community) or direct `amqplib`. Higher operational complexity (vhost, exchange, binding config). RabbitMQ image is heavier (~200MB vs ~30MB for Redis). The video-processing pattern does not need fan-out or routing — a simple FIFO queue suffices, which BullMQ covers equally well with less overhead.

### Option C: Redis Streams (ioredis direct)
- Use Redis Streams (`XADD`/`XREADGROUP`) natively via `ioredis`, without a Bull layer.
- **Pros:** No additional library beyond ioredis. Redis already needed for BullMQ so no new infra dependency. Persistent stream with consumer group semantics.
- **Cons:** No NestJS abstraction — must implement consumer group management, acknowledgements, and retry logic manually. High implementation cost for a well-solved problem. BullMQ already uses Redis Streams internally; using it directly means reimplementing what BullMQ provides.

### Option D: Database-backed queue (TypeORM polling)
- Store jobs in a PostgreSQL table; workers poll periodically.
- **Pros:** No new infrastructure. Uses existing PostgreSQL.
- **Cons:** Polling adds latency and load to the database. No built-in retry/backoff/status machine. Not appropriate for video processing workloads at scale. Anti-pattern when a purpose-built queue is available.

**Recommendation:** **Option A (BullMQ + Redis)** — First-class NestJS integration eliminates glue code. Redis is a lightweight addition that serves a single purpose. BullMQ's job lifecycle (waiting → active → completed/failed) maps directly to the video processing state machine. Retry-with-backoff handles transient FFmpeg failures without manual implementation. The volume of this project (educational platform) does not require RabbitMQ's heavier durability guarantees.

**Decision:** A (BullMQ with Redis / @nestjs/bullmq)

---

## TD-02: Upload Strategy for 10GB Files

**Scope:** Backend + Client Protocol

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Uploading files up to 10GB through a NestJS API endpoint is not viable: the API would hold the TCP connection for minutes, consume memory buffering the stream, and time out under any realistic reverse-proxy config. An alternative strategy that bypasses the API for the data transfer is required.

**Options:**

### Option A: Presigned PUT URL (direct upload to MinIO/S3)
- API generates a time-limited presigned PUT URL for the MinIO object key. The client uploads directly to MinIO using that URL — the API is not in the data path. After the upload completes, the client calls a completion endpoint (`POST /videos/:id/complete`) to notify the API, which then verifies the object exists and enqueues the processing job.
- **Pros:** API handles zero bytes of video data — no memory pressure, no timeout risk, no connection holding. Scales to any file size. MinIO handles the data transfer at storage throughput. Standard pattern for large file upload to S3-compatible storage. Simple client-side implementation (single PUT request). Completion endpoint allows API to verify the object exists before enqueueing.
- **Cons:** Client must be trusted to call the completion endpoint after upload. Storage key must be known before upload (generated by API at initiation). Presigned URL has an expiry — very slow connections on very large files may hit the window (mitigated by setting expiry to 12h for a 10GB upload). Client talks directly to MinIO, requiring MinIO to be network-reachable.

### Option B: Chunked multipart upload proxied through the API
- Client splits the file into chunks and uploads each via `POST /videos/:id/chunks/:index`. API buffers each chunk and assembles in object storage.
- **Pros:** API stays in the data path — can validate, virus-scan, throttle per-chunk.
- **Cons:** API holds every byte of the video in memory or temp storage. For 10GB, this defeats the purpose. Timeout handling for large chunks is complex. Fundamentally incompatible with the performance requirement.

### Option C: TUS resumable upload protocol (tus-node-server)
- TUS is an open protocol for resumable uploads. The server (`tus-node-server`) handles chunking, checksum verification, and resumption. The client uploads directly to the TUS endpoint.
- **Pros:** Resumable — if the connection drops, the upload continues from where it left off. Standardized protocol with clients for all platforms.
- **Cons:** `tus-node-server` requires its own server (separate process or middleware in Express/Fastify). Adds significant complexity: TUS endpoint manages chunk storage (local or S3), final assembly, and cleanup. No official NestJS module. TUS with S3 backend has known edge cases in the library. For Phase 03, resumable upload is an optimization — the missao doesn't require it.

**Recommendation:** **Option A (Presigned PUT URL)** — This is the canonical pattern for large file uploads to S3-compatible storage. It completely bypasses the API for data transfer, satisfies the 10GB requirement with no configuration changes, and is straightforward to implement. The trust model (client calls completion endpoint) is acceptable since the completion endpoint verifies the object exists in MinIO before proceeding. TUS adds complexity not justified by the current requirements.

**Decision:** A (Presigned PUT URL — direct upload to MinIO)

---

## TD-03: Worker Architecture

**Scope:** Backend + Infrastructure

**Capability:** Serviço de processamento em segundo plano (filas), processamento automático do vídeo

**Context:** Video processing (FFprobe + FFmpeg) is CPU-intensive and can take minutes. It must not run inside the API process. The worker must consume BullMQ jobs, access the database (TypeORM), access MinIO (StorageService), and run FFmpeg. The architecture must decide how the worker runs relative to the API codebase.

**Options:**

### Option A: Separate Docker service with a shared NestJS codebase (dedicated bootstrap)
- Create `src/worker.ts` — a NestJS bootstrap that imports only the queue-consuming module (`VideosWorkerModule`) and does not start an HTTP server. Docker Compose adds a `video-worker` service that builds from the same Dockerfile (a `Dockerfile.worker.dev` with FFmpeg installed) and runs `node dist/worker.js` instead of `node dist/main.js`. The worker service shares `src/videos/` entities, repositories, and config modules.
- **Pros:** Single codebase — no duplication of entities, services, or config. Worker and API stay in sync automatically. Independently scalable (can run multiple worker replicas). No HTTP overhead in the worker process. Worker can use the same TypeORM connection config. Simple Dockerfile difference: `apt-get install ffmpeg`.
- **Cons:** Slightly more complex bootstrap: two entrypoints (`main.ts` + `worker.ts`). Worker must not accidentally import HTTP-only modules (Express, Swagger).

### Option B: Separate NestJS application (separate package.json in `video-worker/`)
- A standalone NestJS project in `nestjs-project/video-worker/` with its own `package.json`, dependencies, and TypeORM config.
- **Pros:** Full isolation — worker can evolve independently. No risk of accidentally importing API modules.
- **Cons:** Entity/config duplication or shared library extraction required. Two separate installs and build pipelines. Adds significant project complexity for this phase. The project plan does not anticipate a polyrepo structure.

### Option C: Queue consumer embedded in the API process
- Register BullMQ processors in the API app module. The API handles both HTTP and queue jobs in the same process.
- **Pros:** No separate service — simpler Docker Compose. Shared DI context.
- **Cons:** CPU-intensive FFmpeg processing in the API process degrades HTTP response times. Cannot scale workers independently. FFmpeg must be installed in the API container. Anti-pattern: violates separation of concerns between serving requests and processing media.

**Recommendation:** **Option A (Separate Docker service, shared codebase)** — The shared codebase eliminates duplication while the separate process isolates CPU-intensive work from the API. The two-entrypoint pattern is standard in NestJS for queue-only services. A `Dockerfile.worker.dev` installs FFmpeg without polluting the API image.

**Decision:** A (Separate Docker service — `src/worker.ts` + `Dockerfile.worker.dev`)

---

## TD-04: Video Processing Tool

**Scope:** Backend (Worker)

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados), Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must (1) extract video duration, resolution, codec, bitrate, and other metadata from the uploaded file, and (2) generate a JPEG thumbnail by extracting a representative frame. FFmpeg (with FFprobe) is the industry-standard tool for both tasks. The question is how to integrate it into the Node.js worker.

**Options:**

### Option A: System FFmpeg (installed in Docker) + fluent-ffmpeg (Node.js wrapper)
- Install `ffmpeg` and `ffprobe` via the OS package manager in the worker's Dockerfile (`apt-get install ffmpeg`). Use `fluent-ffmpeg` npm package as the Node.js API wrapper — it spawns ffmpeg/ffprobe as child processes and returns structured results.
- **Pros:** System FFmpeg is always the most recent stable version available in the distro. No binary bundled in node_modules (~60MB savings). `fluent-ffmpeg` has a clean promise-wrappable API for both ffprobe (`ffprobe()`) and screenshot generation (`screenshots()`). TypeScript types available via `@types/fluent-ffmpeg`. Worker Dockerfile is the natural place for OS-level tools.
- **Cons:** FFmpeg must be installed in the Docker image — slightly larger image. Not portable outside the container (dev must have FFmpeg installed if running outside Docker — but CLAUDE.md mandates container-only dev).

### Option B: @ffmpeg-installer/ffmpeg (pre-built binary in node_modules)
- npm package that downloads a pre-built FFmpeg binary for the current platform and exposes its path. Combined with `fluent-ffmpeg`, the binary path is set via `ffmpeg.setFfmpegPath(installer.path)`.
- **Pros:** No system-level FFmpeg installation required — works out of the box after `npm install`. Reproducible binary version.
- **Cons:** Binary versions are often months behind upstream FFmpeg releases. Large node_modules addition (~60MB binary). Separate package for FFprobe (`@ffprobe-installer/ffprobe`). Binary may not match the exact codecs needed. In a Docker environment (this project's standard), installing via `apt-get` is more reliable and better aligned with the project's infra approach.

### Option C: WebAssembly FFmpeg (ffmpeg.wasm)
- FFmpeg compiled to WebAssembly, running entirely in Node.js without a native binary.
- **Pros:** Zero native dependency.
- **Cons:** 10–100x slower than native FFmpeg for real video files. Not suitable for production video processing workloads. High memory usage. Not production-viable for Phase 03.

**Recommendation:** **Option A (System FFmpeg + fluent-ffmpeg)** — Aligns with the project's Docker-first approach. System FFmpeg is the most reliable and up-to-date option. `fluent-ffmpeg` is the de-facto NestJS/Node.js wrapper with mature TypeScript support.

**Decision:** A (System FFmpeg in Dockerfile + fluent-ffmpeg)

---

## TD-05: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, URL-safe unique identifier for its public URL (e.g., `/videos/abc123def456/stream`). This identifier must be collision-resistant without a DB lookup, human-shareable (shorter than UUID), and safe for use in URLs without encoding.

**Options:**

### Option A: nanoid@3.x (short random URL-safe ID)
- `nanoid` generates cryptographically random IDs using a URL-safe alphabet (`A-Za-z0-9_-`). With 12 characters (the default), the collision probability for 1 billion IDs is ~0.0001%. Version 3.x is the last CommonJS-compatible release, compatible with NestJS's CJS build output.
- **Pros:** 12 chars vs 36 for UUID — significantly shorter for shareable links. Cryptographically random. URL-safe alphabet requires no encoding. Zero runtime dependencies. ~500B package size. Version 3.x is CJS-compatible with NestJS (`module: nodenext`, no `"type": "module"` in project).
- **Cons:** Not sortable by creation time (unlike ULID). Requires a uniqueness check on insert (enforced via DB unique constraint — same as any other ID). Version 3.x is older than v5 (ESM), though still actively maintained and widely used.

### Option B: UUID v4 (crypto.randomUUID())
- Use Node.js built-in `crypto.randomUUID()` — no external dependency. 36-character UUID (32 hex + 4 dashes).
- **Pros:** Zero dependency. Already used throughout the project for primary keys. Guaranteed unique (collision probability effectively zero). Built into Node.js 14.17+.
- **Cons:** 36 characters is long for a public-facing URL identifier — not ideal for shareable links. Includes dashes that are visually noisy in URLs. Not as user-friendly as a shorter nanoid.

### Option C: ULID (ulid npm package)
- Universally Unique Lexicographically Sortable Identifier — 26 chars, sortable by generation time.
- **Pros:** Sortable — videos could be listed by creation time without a DB ORDER BY on created_at. URL-safe (Crockford's base32).
- **Cons:** 26 chars — longer than nanoid. Sortability reveals creation timestamp to end users (mild information leak). Extra dependency. No clear advantage over nanoid for Phase 03.

**Recommendation:** **Option A (nanoid@3.x, 12 characters)** — Provides the best balance of uniqueness, brevity, and URL-safety for shareable video links. The DB unique constraint provides the ultimate collision guard. CJS compatibility with the project's build system is confirmed.

**Decision:** A (nanoid@3.x, 12-character URL-safe ID)

---

## TD-06: Streaming Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** Video streaming requires the video player to fetch byte ranges from the file (HTTP Range requests) so playback can start without downloading the entire file. The API must support this without sending the full video in a single response.

**Options:**

### Option A: API proxy with Range requests (206 Partial Content)
- The streaming endpoint reads the client's `Range` header (e.g., `bytes=0-1048575`), fetches that byte range from MinIO using the S3 `GetObject` command with a `Range` parameter, and streams the response body to the client with status 206, `Content-Range`, `Accept-Ranges`, and `Content-Length` headers. The MinIO object is never fully buffered in memory — the response body is piped directly to the client.
- **Pros:** API retains full control over access (auth can be added in Phase 04 for private videos). No direct client-to-MinIO communication — MinIO internal address is never exposed to clients. Consistent with the project's architecture (MinIO is backend infrastructure). Streaming via pipe avoids memory pressure. Future phases can add access control, analytics, CDN offloading without changing client behavior.
- **Cons:** Every streaming request passes through the API, adding a network hop. At high video traffic, the API becomes a throughput bottleneck. Acceptable for Phase 03 scope; a CDN / presigned-URL approach is a Phase 04+ optimization.

### Option B: Presigned GET URL redirect (302 to MinIO)
- API generates a short-lived presigned GET URL for the MinIO object and returns a 302 redirect. The client fetches directly from MinIO.
- **Pros:** Zero API bandwidth for video data — MinIO serves directly to client. Lower API load.
- **Cons:** MinIO's internal Docker hostname (e.g., `minio:9000`) is not reachable from the client browser — presigned URLs must use the external-facing MinIO host/port. Exposes MinIO URL structure to clients. Makes future per-request access control harder (presigned URLs are hard to invalidate). Phase 04 will add visibility/access controls — the redirect approach complicates that.

### Option C: Direct MinIO access with CORS config
- Client fetches directly from MinIO (with CORS headers configured). No API involvement for streaming.
- **Pros:** Maximum throughput — client fetches directly.
- **Cons:** Requires CORS configuration and MinIO to be accessible from the browser. Exposes storage internals. No API-level access control. Anti-pattern for the project's architecture.

**Recommendation:** **Option A (API proxy with Range requests)** — Keeps MinIO as a backend implementation detail invisible to clients. Supports future access control for private videos. For Phase 03's scope (functional streaming, not production throughput), the API proxy is the correct architecture. The pipe-based streaming prevents memory issues even for large files.

**Decision:** A (API proxy with 206 Partial Content Range requests)

---

## TD-07: Video Status Lifecycle

**Scope:** Backend

**Capability:** Ciclo de status do vídeo e o que acontece em caso de falha no processamento

**Context:** Videos move through states from initial registration to final availability (or failure). The status must be stored in the DB, drive API behavior (e.g., prevent streaming of unready videos), and reflect worker outcomes.

**Options:**

### Option A: Four-state lifecycle: draft → processing → ready | error
- `draft`: Video record created when upload initiation is called. Presigned URL generated.
- `processing`: Client called the completion endpoint; API verified the object exists in MinIO; job enqueued to BullMQ.
- `ready`: Worker successfully extracted metadata and generated thumbnail; video is available for streaming and download.
- `error`: Worker failed after all retries; video is not available; `processing_error` field contains the last error message.
- **Pros:** Clear, minimal state machine. Each state maps to a concrete trigger. No ambiguous intermediate states. "Draft" matches the missao requirement ("pré-cadastro automático do vídeo como rascunho"). Transitions are idempotent — calling complete on a processing video is rejected (409). Phase 04 will add more states (e.g., `published`, `unlisted`) on top of `ready`.
- **Cons:** No explicit `uploading` state to represent "presigned URL issued, upload in progress". If the client never calls complete, the video stays as `draft` indefinitely (handled by a cleanup job in Phase 04+).

### Option B: Five-state lifecycle: draft → uploading → processing → ready | error
- Adds `uploading` state: set when the presigned URL is generated (initiation), not when the completion endpoint is called.
- **Pros:** More granular — can distinguish between "just created" and "upload in progress".
- **Cons:** The API cannot know when the client actually starts uploading — the transition to `uploading` happens at URL generation time, which is the same moment as `draft` creation. The extra state adds complexity without a meaningful behavioral difference: the API cannot observe the upload progress since it is direct-to-MinIO.

**Recommendation:** **Option A (four-state: draft → processing → ready | error)** — The `uploading` intermediate state (B) provides no actionable information to the API since the upload happens directly in MinIO. The four-state machine is the minimal correct model. Phase 04 can extend with `published`/`unlisted` on top of `ready`.

**Decision:** A (draft → processing → ready | error)

---

## Decisions Summary

| ID | Decision | Recommendation | Choice |
|----|----------|---------------|--------|
| TD-01 | Queue Technology | BullMQ + Redis | A (BullMQ + Redis / @nestjs/bullmq) |
| TD-02 | Upload Strategy for 10GB Files | Presigned PUT URL | A (Presigned PUT URL — direct to MinIO) |
| TD-03 | Worker Architecture | Separate Docker service, shared codebase | A (src/worker.ts + Dockerfile.worker.dev) |
| TD-04 | Video Processing Tool | System FFmpeg + fluent-ffmpeg | A (System FFmpeg in Dockerfile + fluent-ffmpeg) |
| TD-05 | Unique Video URL Identifier | nanoid@3.x, 12 chars | A (nanoid@3.x, 12-character ID) |
| TD-06 | Streaming Strategy | API proxy with Range/206 | A (API proxy with 206 Partial Content) |
| TD-07 | Video Status Lifecycle | Four-state machine | A (draft → processing → ready / error) |
