---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-08T00:00:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-08T00:00:00-03:00"
issues: []
advisories:
  - "Advisory: cleanup de rascunhos (vídeos em status 'draft' cujo upload nunca foi concluído) está explicitamente diferido para Phase 04+. Não é um gap desta fase — é uma decisão de escopo documentada em context.md."
  - "Advisory: StorageService.getObject() proxy de streaming retorna um stream (não buffer) — assegurar no plano que o VideoProcessor usa arquivo temporário em disco, não buffering in-memory, para evitar OOM em arquivos de 10GB durante processamento."
  - "Advisory: nanoid@3.x é a última versão CJS-compatível — confirmar na library-refs que a versão instalada é ^3.x (não ^5.x ESM-only) dado que o projeto usa nodenext/CJS output."
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._ Todas as decisões abertas do plano do projeto (fila TBD, estratégia de upload, worker, streaming, URL única, ciclo de status) foram resolvidas no `technical-decisions-phase-03-videos.md`.

### Missing Decisions

_None._ As sete decisões técnicas da fase estão todas marcadas como `decided` no Decisions Index do context.md.

### Dependency Gaps

_None._ 

- `channel_id` FK na entidade Video → tabela `channels` existe desde Fase 02 (migration `CreateUsersAndChannels`). Relação válida.
- `JwtAuthGuard` global herdado da Fase 02 — endpoints de upload/completion usam JWT, endpoints de streaming/download usam `@Public()`. Sem gap de auth.
- `ConfigModule.forRoot({ isGlobal: true })` configurado na Fase 01 — novos `registerAs` namespaces de storage/queue/videos herdam essa configuração. Sem gap de DI.

### Inherited Constraint Conflicts

_None._

- BullMQ + Redis não conflita com nenhuma dependência existente.
- `@aws-sdk/client-s3` não conflita com `@nestjs/jwt`, `typeorm`, ou demais pacotes da Fase 02.
- `nanoid@3.x` é CJS puro — sem conflito com `nodenext` module resolution.
- `fluent-ffmpeg` é instalado apenas no `Dockerfile.worker.dev`, não no container da API.

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ Fase 03 é explicitamente backend-only (per missao.md: "Este é um desafio de backend: a entrega é a API, o worker, a infraestrutura e os artefatos do processo").

## Resolved Issues

_No issues found during validation — proceeding directly to plan-build._

## Advisories (non-blocking)

1. **Rascunhos abandonados:** Vídeos criados (status `draft`) cujo cliente nunca chamou o endpoint de completion ficam no banco indefinidamente. Não é um bug desta fase — é escopo deferido (cleanup job em Phase 04+). Documentado em `context.md > Non-UI / Deferred Capabilities`.

2. **Worker: arquivo temporário em disco, não buffer in-memory:** O VideoProcessor deve baixar o vídeo do MinIO para um arquivo temporário (ex: `/tmp/{videoId}.mp4`) antes de rodar `ffprobe` e `ffmpeg`. Não deve usar streams em memória para um arquivo de 10GB. O plano deve especificar o path de download temporário e a limpeza do arquivo após o processamento.

3. **nanoid version pin:** O library-refs.md deve registrar `nanoid@^3.x` explicitamente. Versões ≥ 5 são ESM-only e incompatíveis com o CJS output do projeto (nodenext sem `"type": "module"` no package.json).
