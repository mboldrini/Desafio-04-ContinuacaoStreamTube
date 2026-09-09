---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-08T00:00:00-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-05-12T13:36:17-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Object storage para os arquivos de vídeo e thumbnails (MinIO, S3-compatible)
- Fila de processamento em segundo plano e um worker que a consome (BullMQ + Redis)
- Upload de vídeos de até 10GB sem impacto na performance (presigned PUT URL — direto ao MinIO)
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados via FFprobe)
- Geração automática de thumbnail a partir de um frame do vídeo (FFmpeg)
- URL única por vídeo, sem conflito com outros vídeos (nanoid@3.x, 12 caracteres)
- Reprodução via streaming (sem necessidade de download completo) — API proxy com Range/206
- Download do vídeo pelo usuário

**Out of scope:** Edição de metadados do vídeo (título, descrição, categoria, thumbnail customizada), visibilidade (público/unlisted), fluxo de rascunho→publicação, comentários, likes, inscrições, e o frontend de vídeo.

**Deliverables:** Upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas, infraestrutura nova (MinIO + Redis + worker) subindo via Docker Compose.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — interface de upload e player de vídeo ficam para Fase 04+.

**Sequencing notes:** Depends on Fase 01 (base config) and Fase 02 (auth, channels). Vídeos pertencem a um canal — `channel_id` FK referencia a tabela `channels` criada na Fase 02.

**Neighbors (for boundary detection only):** Fase 02 (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend + Infra | Queue Technology | decided | A (BullMQ + Redis / @nestjs/bullmq) | @nestjs/bullmq@^11.x, bullmq@^5.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend + Protocol | Upload Strategy for 10GB Files | decided | A (Presigned PUT URL — direct to MinIO) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend + Infra | Worker Architecture | decided | A (src/worker.ts + Dockerfile.worker.dev) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend (Worker) | Video Processing Tool | decided | A (System FFmpeg + fluent-ffmpeg) | fluent-ffmpeg@^2.x, @types/fluent-ffmpeg@^2.x |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | A (nanoid@3.x, 12 chars) | nanoid@^3.x |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Streaming Strategy | decided | A (API proxy with Range/206) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle | decided | A (draft → processing → ready / error) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Object storage para vídeos e thumbnails | phase-03-videos/TD-02 (presigned URL strategy), project decision (MinIO) |
| Fila de processamento e worker | phase-03-videos/TD-01 (BullMQ + Redis), phase-03-videos/TD-03 (worker arch) |
| Upload de até 10GB sem impacto | phase-03-videos/TD-02 (presigned PUT URL bypass) |
| Pré-cadastro como rascunho | phase-03-videos/TD-07 (status lifecycle — draft initial state) |
| Processamento automático (duração e metadados) | phase-03-videos/TD-04 (FFprobe via fluent-ffmpeg) |
| Thumbnail automática | phase-03-videos/TD-04 (FFmpeg via fluent-ffmpeg) |
| URL única por vídeo | phase-03-videos/TD-05 (nanoid@3.x, 12 chars, DB unique constraint) |
| Streaming sem download completo | phase-03-videos/TD-06 (API proxy Range/206) |
| Download do vídeo | _Derived from TD-06 (API proxy) + same object key — Content-Disposition: attachment_ |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — First-class NestJS integration (@nestjs/bullmq), built-in job lifecycle and retries, lightweight Redis infrastructure. BullMQ's job state machine (waiting → active → completed/failed) maps directly to the video processing lifecycle.

**Libraries:** `@nestjs/bullmq@^11.x`, `bullmq@^5.x`

### phase-03-videos/TD-02

**Recommendation:** Presigned PUT URL — Client uploads directly to MinIO, bypassing the API entirely. API generates the URL at initiation, verifies object existence at completion, and then enqueues the processing job. Zero API memory pressure for video data.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** Separate Docker service sharing the NestJS codebase. `src/worker.ts` bootstraps a NestJS app without HTTP (`NestFactory.createApplicationContext`). `Dockerfile.worker.dev` installs FFmpeg and runs `node dist/worker.js`. The video-worker service in compose.yaml shares the same volume mount.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** System FFmpeg installed in the worker Dockerfile via `apt-get install ffmpeg`. `fluent-ffmpeg` wraps the CLI: `ffprobe()` for metadata extraction, `screenshots()` for thumbnail generation. TypeScript types via `@types/fluent-ffmpeg`.

**Libraries:** `fluent-ffmpeg@^2.x`, `@types/fluent-ffmpeg@^2.x`

### phase-03-videos/TD-05

**Recommendation:** `nanoid@3.x` (last CJS release — compatible with NestJS's CJS build output), 12-character URL-safe alphabet (`A-Za-z0-9_-`). DB unique constraint provides the final collision guard. Generated at video record creation time.

**Libraries:** `nanoid@^3.x`

### phase-03-videos/TD-06

**Recommendation:** API proxy with Range/206 — streaming endpoint reads `Range` header, fetches corresponding byte range from MinIO via `@aws-sdk/client-s3` `GetObject` with Range, pipes the response body stream to the client with 206 status and correct `Content-Range`/`Accept-Ranges` headers. No full buffering in API memory.

**Libraries:** _(uses @aws-sdk/client-s3 from TD-02)_

### phase-03-videos/TD-07

**Recommendation:** Four-state machine: `draft` (video record created, presigned URL issued) → `processing` (upload verified in MinIO, job enqueued) → `ready` (worker processed successfully) | `error` (worker failed all retries, `processing_error` populated). The API rejects streaming/download of non-`ready` videos with 422.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability.

**Libraries:** —

### phase-02-auth/TD-02

**Recommendation:** Custom guards with @nestjs/jwt — `JwtAuthGuard` global guard, `@Public()` decorator to opt out. All video endpoints that require auth use the global guard; streaming and download are `@Public()`.

**Libraries:** `@nestjs/jwt@^11.0.0`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables validated by Joi schema in `src/config/env.validation.ts`. _(from phase 01)_
- Config injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Global JWT guard (`JwtAuthGuard`) — all endpoints require auth by default; `@Public()` to opt out. _(from phase 02)_
- Error response format `{ statusCode, error, message }` with domain exception codes. _(from phase 02)_
- Global `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`. _(from phase 02)_
- Test suffixes: `*.spec.ts` (unit), `*.integration-spec.ts` (integration), `*.e2e-spec.ts` (e2e). _(from phase 02)_
- All commands run inside the Docker container via `docker compose exec nestjs-api`. _(from nestjs-project/CLAUDE.md)_
- Docker Compose service names as hostnames — never `localhost` for inter-service communication. _(from CLAUDE.md)_

## Inherited Deferred Capabilities

_No deferred capabilities inherited from prior phases that intersect with Phase 03 scope._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Frontend de upload e player de vídeo | deferred | `next-frontend/` video UI is out of Phase 03 scope per missao.md | — |
| Edição de metadados do vídeo (título, descrição, categoria, thumbnail customizada) | deferred | Phase 04 scope | — |
| Visibilidade do vídeo (público/unlisted) | deferred | Phase 04 scope | — |
| Cleanup de rascunhos abandonados | deferred | Videos stuck in `draft` status (upload never completed) require a cron job — Phase 04+ | — |

## Testing Requirements

Refer to `testing-guide-nestjs-project` skill for layer requirements. Phase 03 adds a new module (`videos/`), a new infrastructure service (StorageService), a new queue consumer (VideoProcessor), and new HTTP endpoints. Coverage per layer:

- **Unit:** VideosService, StorageService (mocked SDK), VideoProcessor (mocked fs + ffprobe + ffmpeg), DTO validation, domain exceptions
- **Integration:** Video entity constraints (unique_id, FK to channel), VideosService with real DB and mocked MinIO, StorageService with real MinIO container
- **E2E:** `POST /videos/upload-init`, `POST /videos/:id/complete`, `GET /videos/:uniqueId/stream`, `GET /videos/:uniqueId/download` via supertest against full running app
