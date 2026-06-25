# token-pool

Self-hosted LLM routing proxy with fusion model support, free-provider rate limits, multi-tier routing, and WebUI. OpenAI-compatible API surface. Deployable via Docker Compose.

Built in TypeScript for fast iteration.

## Current Status

**Step 1 — Core proxy: DONE**
- Fastify server, OpenAI-compatible `/v1/chat/completions` + `/v1/models`
- Streaming passthrough (SSE)
- Provider proxy with undici (streaming, non-streaming)
- SQLite database with WAL mode, full schema (users, providers, keys, models, tiers, fusion pools, usage events, rate limit state)
- 7 free providers pre-seeded (OpenRouter, Google AI Studio, Groq, Cerebras, Mistral, GitHub Models, Cohere)
- 5 tiers pre-seeded (simple, standard, reasoning, complex, multimodal)
- Tier classification pipeline (explicit override → modality → context length → keywords → token count)
- Fallback chain resolution
- AES-256-GCM encrypted key storage
- Admin REST API for providers CRUD, provider keys, tiers, stats
- 16 tests passing (crypto, classification, database)

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js (ESM, TypeScript) |
| HTTP server | Fastify 5 |
| HTTP client | undici (streaming) |
| Database | SQLite (better-sqlite3) |
| Auth crypto | AES-256-GCM (Node crypto) |
| Tests | Vitest |
| Dev runner | tsx (watch mode) |

## Quick Start

```bash
npm install
npm run dev          # starts on :8000
npm test             # 16 tests
npm run typecheck    # tsc --noEmit
```

## API

```
POST /v1/chat/completions       — main routing endpoint (OpenAI-compatible)
GET  /v1/models                 — list available models

GET  /v1/admin/providers        — list providers
POST /v1/admin/providers        — create provider
PUT  /v1/admin/providers/:id    — update provider
DELETE /v1/admin/providers/:id  — delete provider

GET  /v1/admin/providers/:id/keys   — list provider keys
POST /v1/admin/providers/:id/keys   — add key
DELETE /v1/admin/providers/:id/keys/:keyId  — delete key

GET  /v1/admin/tiers                    — list tiers
GET  /v1/admin/tiers/:name/models       — list tier models
PUT  /v1/admin/tiers/:name/models       — set tier models (fallback chain)

GET  /v1/admin/stats                    — aggregated stats
GET  /v1/admin/stats/users              — per-user stats
GET  /v1/admin/stats/providers          — per-provider stats

GET  /health
```

## Build Order (from design doc)

1. ✅ Core proxy — server, forwarding, streaming, /health, /v1/models
2. ✅ Provider DB + CRUD — SQLite schema, provider management, encrypted keys
3. ⬜ Rate limit guard — per-key quota tracking, try_acquire, backoff, round-robin
4. ⬜ Tier classification + fallback chains (classification done, needs tier_models config)
5. ⬜ models.dev integration — background fetch, metadata cache
6. ⬜ Transcoding subsystem — ffmpeg wrapper
7. ⬜ Multi-user auth — JWT, admin/regular roles
8. ⬜ Usage tracking — usage_events writes
9. ⬜ Fusion engine — parallel fan-out, arbiter strategies
10. ⬜ WebUI — React frontend
11. ⬜ Docker Compose — packaging, first-run bootstrap
