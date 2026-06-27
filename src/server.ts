import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { loadConfig, type AppConfig } from "@/config";
import { DatabaseService } from "@/db";
import { CryptoService } from "@/auth/crypto";
import { ProviderService } from "@/providers";
import { ProviderProxy, ProxyError } from "@/providers/proxy";
import { RateLimitGuard } from "@/providers/rate-limiter";
import { ConcurrencyGuard } from "@/providers/concurrency-guard";
import { ModelMetadataSync } from "@/providers/model-sync";
import { FusionService } from "@/fusion";
import { FusionEngine, FusionError } from "@/fusion/engine";
import { UserService } from "@/auth/user-service";
import { registerAuth, setupAuthGuards, signToken, type JwtPayload } from "@/auth/middleware";
import { UsageTracker } from "@/stats";
import { OAuthService } from "@/auth/oauth";
import { classifyRequest, estimateTokens } from "@/router/classify";
import { resolveTierModel, getFallbackChain, type ResolvedModel } from "@/router/resolve";
import type { ChatCompletionRequest, ChatCompletionResponse } from "@/types";

export class TokenPoolServer {
  private fastify: FastifyInstance;
  private db: DatabaseService;
  private crypto: CryptoService;
  private providers: ProviderService;
  private proxy: ProviderProxy;
  private guard: RateLimitGuard;
  private concurrencyGuard: ConcurrencyGuard;
  private fusion: FusionService;
  private fusionEngine: FusionEngine;
  private modelSync: ModelMetadataSync;
  private users: UserService;
  private usage: UsageTracker;
  private oauth: OAuthService;
  private config: AppConfig;

  constructor() {
    this.config = loadConfig();
    this.ensureSecret();

    this.db = new DatabaseService(this.config.databaseUrl);
    this.crypto = new CryptoService(this.config.appSecret);
    this.providers = new ProviderService(this.db);
    this.proxy = new ProviderProxy(this.providers, this.crypto);
    this.guard = new RateLimitGuard(this.db, this.providers);
    this.concurrencyGuard = new ConcurrencyGuard();
    this.fusion = new FusionService(this.db);
    this.fusionEngine = new FusionEngine(this.providers, this.proxy, this.crypto, this.guard, this.fusion);
    this.modelSync = new ModelMetadataSync(this.providers, this.crypto, this.config.modelsRefreshIntervalSec);
    this.users = new UserService(this.db);
    this.usage = new UsageTracker(this.db);
    this.oauth = new OAuthService(this.db, this.crypto, this.providers);

    this.fastify = Fastify({ logger: true });
  }

  private ensureSecret() {
    if (!this.config.appSecret) {
      this.config.appSecret = randomBytes(32).toString("hex");
      console.warn("[token-pool] APP_SECRET not set — generated ephemeral secret for dev. Set APP_SECRET in production.");
    }
  }

  async start() {
    await this.registerPlugins();
    this.registerRoutes();
    this.modelSync.start();
    this.bootstrapAdmin();

    try {
      await this.fastify.listen({ port: this.config.port, host: this.config.host });
    } catch (err) {
      this.fastify.log.error(err);
      process.exit(1);
    }
  }

  private bootstrapAdmin() {
    const result = this.users.bootstrapAdmin(this.config.adminPassword);
    if (result) {
      const banner = "═".repeat(63);
      console.log(`\n${banner}`);
      console.log("  token-pool: first-run admin bootstrap");
      console.log(banner);
      console.log(`  Username: ${result.username}`);
      console.log(`  Password: ${result.password}`);
      console.log("\n  Save this password. It will NOT be shown again.");
      console.log(`${banner}\n`);
    }
  }

  private async registerPlugins() {
    await this.fastify.register(cors, { origin: true });
    registerAuth(this.fastify, this.config.appSecret);
    setupAuthGuards(this.fastify, this.users);

    // Serve WebUI if built
    const webDir = join(__dirname, "web", "dist");
    if (existsSync(webDir)) {
      await this.fastify.register(fastifyStatic, {
        root: webDir,
        prefix: "/ui/",
        decorateReply: true,
      });
      // SPA fallback: /ui → index.html
      this.fastify.get("/ui", async (_req: any, reply: any) => {
        return reply.sendFile("index.html");
      });
    }
  }

  private registerRoutes() {
    // ── Health ──
    this.fastify.get("/health", async () => ({ status: "ok" }));

    // ── Auth: login ──
    this.fastify.post("/v1/auth/login", async (request, reply) => {
      const { username, password } = request.body as { username: string; password: string };
      if (!username || !password) {
        return reply.code(400).send({ error: { message: "username and password required", type: "invalid_request", code: null } });
      }
      const user = this.users.verifyPassword(username, password);
      if (!user) {
        return reply.code(401).send({ error: { message: "Invalid credentials", type: "auth_error", code: null } });
      }
      const token = signToken(this.fastify, user);
      return { token, user: { id: user.id, username: user.username, role: user.role } };
    });

    // ── Auth: me ──
    this.fastify.get("/v1/auth/me", {
      preHandler: this.fastify.authVerify,
    }, async (request) => {
      const payload = (request as any).user as JwtPayload;
      const user = this.users.getById(payload.sub);
      if (!user) return { error: "user not found" };
      return { id: user.id, username: user.username, role: user.role };
    });

    // ── List models (+ routing profiles as virtual models) ──
    this.fastify.get("/v1/models", async () => {
      const dbModels = this.providers.listModels();
      const data = dbModels.map(m => ({
        id: m.modelId,
        object: "model" as const,
        created: 0,
        owned_by: m.providerId.toString(),
      }));

      // Also list routing profiles as selectable models
      const profiles = this.db.prepare("SELECT * FROM routing_profiles ORDER BY name").all() as any[];
      for (const p of profiles) {
        data.push({
          id: `profile:${p.name}`,
          object: "model" as const,
          created: 0,
          owned_by: "router",
        });
      }

      // Also list tier names as selectable models
      const tiers = this.db.prepare("SELECT name FROM tiers ORDER BY id").all() as { name: string }[];
      for (const t of tiers) {
        // Only add if not already a model ID
        if (!data.some(d => d.id === t.name)) {
          data.push({
            id: t.name,
            object: "model" as const,
            created: 0,
            owned_by: "tier",
          });
        }
      }

      return { object: "list", data };
    });

    // ── Chat completions — main routing endpoint ──
    this.fastify.post("/v1/chat/completions", async (request, reply) => {
      const body = request.body as ChatCompletionRequest;

      if (!body?.model || !body?.messages?.length) {
        return reply.code(400).send({
          error: { message: "model and messages are required", type: "invalid_request", code: null },
        });
      }

      // Fusion is always available via model="fusion:poolname"
      if (body.model.startsWith("fusion:")) {
        try {
          const result = await this.fusionEngine.execute(body, body.model);
          reply.header("x-resolved-model", `fusion:${result.poolName}`);

          this.usage.record({
            userId: 1,
            providerId: null,
            modelId: `fusion:${result.poolName}`,
            tier: "fusion",
            inputTokens: result.response.usage?.prompt_tokens ?? 0,
            outputTokens: result.response.usage?.completion_tokens ?? 0,
            latencyMs: 0,
            fusionPoolId: this.fusion.getByName(result.poolName)?.id,
          });

          return reply.send(result.response);
        } catch (err: any) {
          if (err instanceof FusionError) {
            return reply.code(err.statusCode).send({
              error: { message: err.message, type: "fusion_error", code: null },
            });
          }
          throw err;
        }
      }

      // ── Resolve what to route to ──
      // Resolution order:
      // 1. X-Router-Profile header → use named profile
      // 2. model="profile:name" → use named profile
      // 3. model contains "/" → direct provider/model passthrough
      // 4. model matches a known modelId → direct to that model (any provider)
      // 5. model is a tier name → tier routing
      // 6. Default → auto-classify + tier routing

      const profileHeader = request.headers["x-router-profile"] as string | undefined;
      const profileName = body.model.startsWith("profile:")
        ? body.model.slice("profile:".length)
        : profileHeader;

      let mode: "auto" | "tier" | "direct" | "fusion" = "auto";
      let target: string | null = null;
      let fallbackEnabled = true;

      if (profileName) {
        // Look up routing profile by name
        const profile = this.db.prepare(
          "SELECT * FROM routing_profiles WHERE name = ?"
        ).get(profileName) as
          | { mode: string; target: string | null; fallback_enabled: number }
          | undefined;

        if (!profile) {
          return reply.code(404).send({
            error: { message: `Routing profile '${profileName}' not found`, type: "not_found", code: null },
          });
        }

        mode = profile.mode as "auto" | "tier" | "direct" | "fusion";
        target = profile.target;
        fallbackEnabled = profile.fallback_enabled === 1;

        // If profile mode is direct, override the model with target
        if (mode === "direct" && target) {
          body.model = target;
        }
      } else if (body.model.includes("/")) {
        // Direct provider/model passthrough (existing behavior)
        mode = "direct";
      } else {
        // Check if model matches a known modelId
        const allModels = this.providers.listModels();
        const knownModel = allModels.find(m => m.modelId === body.model);
        if (knownModel) {
          mode = "direct";
          // Keep body.model as-is — handleDirectRoute will resolve it
        } else {
          // Check if it's a tier name
          const tierRow = this.db.prepare("SELECT name FROM tiers WHERE name = ?").get(body.model) as { name: string } | undefined;
          if (tierRow) {
            mode = "tier";
            target = body.model;
          }
          // else: auto-classify (default)
        }
      }

      // ── Execute based on mode ──

      if (mode === "direct") {
        const result = await this.handleDirectRoute(body, reply, fallbackEnabled);
        return result;
      }

      if (mode === "tier") {
        const tier = target as string;
        const estTokens = estimateTokens(body) + (body.max_tokens ?? 1000);
        const chain = getFallbackChain(this.db, this.providers, this.guard, tier as any, estTokens);
        if (chain.length === 0) {
          return reply.code(503).send({
            error: {
              message: `No models configured or available for tier '${tier}'.`,
              type: "no_provider",
              code: null,
            },
          });
        }
        return await this.tryFallbackChain(body, chain, reply, tier);
      }

      // mode === "auto" — classify and route
      const explicitTier = request.headers["x-router-tier"] as string | undefined;
      const classification = classifyRequest(body, explicitTier);
      const estTokens = estimateTokens(body) + (body.max_tokens ?? 1000);
      const chain = getFallbackChain(this.db, this.providers, this.guard, classification.tier, estTokens);

      if (chain.length === 0) {
        return reply.code(503).send({
          error: {
            message: `No models configured or available for tier '${classification.tier}'. Configure tier models via admin API.`,
            type: "no_provider",
            code: null,
          },
        });
      }

      return await this.tryFallbackChain(body, chain, reply, classification.tier);
    });

    this.registerAdminRoutes();
  }

  /**
   * Try each model in the fallback chain. If fallback is disabled, only try the first.
   */
  private async tryFallbackChain(
    body: ChatCompletionRequest,
    chain: ResolvedModel[],
    reply: any,
    tierLabel: string,
  ) {
    const models = chain; // use all if fallback enabled, else just first
    for (const resolved of models) {
      try {
        return await this.handleProxy(body, resolved, reply, tierLabel);
      } catch (err: any) {
        if (err instanceof ProxyError && err.statusCode === 429) {
          this.guard.markBackoff(resolved.key.id);
          this.fastify.log.warn(
            { model: resolved.modelId, provider: resolved.provider.name },
            "Provider 429 — key backed off, trying next in chain"
          );
        } else {
          this.fastify.log.warn(
            { err, model: resolved.modelId, provider: resolved.provider.name },
            "Provider failed, trying next in chain"
          );
        }
        continue;
      }
    }

    return reply.code(502).send({
      error: { message: "All providers in fallback chain failed", type: "upstream_error", code: null },
    });
  }

  /**
   * Resolve a model name to provider+key and proxy the request.
   * Supports both "provider/model" format and bare model names.
   * If fallbackEnabled, tries other providers for same model on failure.
   */
  private async handleDirectRoute(
    body: ChatCompletionRequest,
    reply: any,
    fallbackEnabled: boolean = true,
  ) {
    const allModels = this.providers.listModels();

    // Find all providers that have this model
    // If model contains "/", it's "provider/modelId" — find exact match
    // Otherwise, find all providers that have this modelId
    let candidates: typeof allModels;
    if (body.model.includes("/")) {
      const exact = allModels.find(m => m.modelId === body.model);
      candidates = exact ? [exact] : [];
    } else {
      candidates = allModels.filter(m => m.modelId === body.model);
    }

    if (candidates.length === 0) {
      return reply.code(404).send({
        error: { message: `Model '${body.model}' not found`, type: "not_found", code: null },
      });
    }

    // Try each provider that has this model
    for (const model of candidates) {
      const provider = this.providers.get(model.providerId);
      if (!provider || !provider.enabled) continue;

      const estTokens = estimateTokens(body) + (body.max_tokens ?? 1000);
      const decision = this.guard.tryAcquire(provider, estTokens);
      if (!decision.allowed || !decision.key) {
        if (!fallbackEnabled) {
          return reply.code(429).send({
            error: {
              message: `Rate limit exceeded for ${provider.name}: ${decision.reason}`,
              type: "rate_limit_exceeded",
              code: null,
            },
          });
        }
        continue; // try next provider
      }

      const resolved: ResolvedModel = {
        modelId: body.model,
        provider,
        key: decision.key,
      };

      try {
        return await this.handleProxy(body, resolved, reply, "direct");
      } catch (err: any) {
        if (!fallbackEnabled) throw err;
        this.fastify.log.warn(
          { err, model: body.model, provider: provider.name },
          "Direct route failed, trying next provider"
        );
        continue;
      }
    }

    return reply.code(503).send({
      error: { message: `No available provider for model '${body.model}'`, type: "no_provider", code: null },
    });
  }

  private async handleProxy(
    body: ChatCompletionRequest,
    resolved: ResolvedModel,
    reply: any,
    tierLabel: string = "standard",
    userId: number = 1, // default user until auth on /v1/chat/completions
  ) {
    const startTime = Date.now();

    // ── Concurrency guard: acquire slot before forwarding ──
    const provider = resolved.provider;
    const concurrencyDecision = this.concurrencyGuard.tryAcquire(provider.id, provider.maxConcurrentRequests);
    if (!concurrencyDecision.allowed) {
      if (concurrencyDecision.retryAfterSec) {
        reply.header("Retry-After", String(concurrencyDecision.retryAfterSec));
      }
      return reply.code(429).send({
        error: {
          message: `Concurrency limit exceeded for ${provider.name}: ${concurrencyDecision.reason}`,
          type: "concurrency_limit_exceeded",
          code: null,
        },
      });
    }

    try {
      // ── Budget check ──
      const budgetCheck = this.usage.checkBudget(provider.id);
      if (budgetCheck.exceeded) {
        return reply.code(429).send({
          error: { message: budgetCheck.reason!, type: "budget_exceeded", code: null },
        });
      }

      const result = await this.proxy.forward(provider, resolved.modelId, body, resolved.key);

      if (result.status === 429) {
        this.guard.markBackoff(resolved.key.id);
        throw new ProxyError(`Upstream 429 from ${provider.name}`, 429);
      }

      if (result.status !== 200) {
        const text = typeof result.body === "string"
          ? result.body
          : await new Response(result.body as any).text();
        throw new ProxyError(`Upstream ${result.status}: ${text}`, result.status);
      }

      // Clear backoff on success
      this.guard.clearBackoff(resolved.key.id);

      // Stream passthrough
      if (body.stream) {
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "x-resolved-model": resolved.modelId,
        });

        const reader = (result.body as ReadableStream<Uint8Array>).getReader();
        const writer = reply.raw;
        let outputTokens = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            writer.write(Buffer.from(value));
            // Try to count tokens from SSE chunks
            outputTokens += countStreamTokens(value);
          }
        } catch (err) {
          this.fastify.log.error({ err }, "Stream error");
        } finally {
          writer.end();
        }

        // Record usage (input estimate, output from stream count)
        this.usage.record({
          userId,
          providerId: provider.id,
          modelId: resolved.modelId,
          tier: tierLabel as any,
          inputTokens: estimateTokens(body),
          outputTokens,
          latencyMs: Date.now() - startTime,
        });

        return reply;
      }

      // Buffered response
      const text = typeof result.body === "string"
        ? result.body
        : await new Response(result.body as any).text();

      const data = JSON.parse(text);
      reply.header("x-resolved-model", resolved.modelId);

      // Record usage from response
      const usage = (data as any)?.usage;
      this.usage.record({
        userId,
        providerId: provider.id,
        modelId: resolved.modelId,
        tier: tierLabel as any,
        inputTokens: usage?.prompt_tokens ?? estimateTokens(body),
        outputTokens: usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - startTime,
      });

      return reply.send(data);
    } finally {
      // ── Always release the concurrency slot ──
      this.concurrencyGuard.release(provider.id);
    }
  }

  // ── Admin routes (auth required) ──
  private registerAdminRoutes() {
    const adminGuard = { preHandler: [this.fastify.authVerify, this.fastify.authAdmin] };

    // Providers CRUD
    this.fastify.get("/v1/admin/providers", adminGuard, async () => {
      return this.providers.list();
    });

    this.fastify.post("/v1/admin/providers", adminGuard, async (request, reply) => {
      const body = request.body as any;
      try {
        const id = this.providers.create({
          name: body.name,
          baseUrl: body.baseUrl,
          type: body.type ?? "free",
          wireFormat: body.wireFormat ?? "openai",
          rpmLimit: body.rpmLimit ?? null,
          rpdLimit: body.rpdLimit ?? null,
          tpmLimit: body.tpmLimit ?? null,
          tpdLimit: body.tpdLimit ?? null,
          maxConcurrentRequests: body.maxConcurrentRequests ?? null,
          enabled: body.enabled ?? true,
        });
        return reply.code(201).send({ id });
      } catch (err: any) {
        return reply.code(400).send({
          error: { message: err.message, type: "invalid_request", code: null },
        });
      }
    });

    this.fastify.put("/v1/admin/providers/:id", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      const body = request.body as any;
      const ok = this.providers.update(id, body);
      return ok ? reply.send({ ok }) : reply.code(404).send({ error: { message: "not found", type: "not_found", code: null } });
    });

    this.fastify.delete("/v1/admin/providers/:id", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      const ok = this.providers.delete(id);
      return ok ? reply.send({ ok }) : reply.code(404).send({ error: { message: "not found", type: "not_found", code: null } });
    });

    // Provider keys
    this.fastify.get("/v1/admin/providers/:id/keys", adminGuard, async (request) => {
      const id = parseInt((request.params as any).id, 10);
      return this.providers.listKeys(id);
    });

    this.fastify.post("/v1/admin/providers/:id/keys", adminGuard, async (request, reply) => {
      const providerId = parseInt((request.params as any).id, 10);
      const body = request.body as any;
      const encKey = this.crypto.encrypt(body.apiKey);
      const keyId = this.providers.addKey(providerId, body.label ?? "key", encKey, body.limits);
      return reply.code(201).send({ id: keyId });
    });

    this.fastify.delete("/v1/admin/providers/:id/keys/:keyId", adminGuard, async (request, reply) => {
      const keyId = parseInt((request.params as any).keyId, 10);
      const ok = this.providers.deleteKey(keyId);
      return ok ? reply.send({ ok }) : reply.code(404).send({ error: { message: "not found", type: "not_found", code: "null" } });
    });

    // Rate limit usage
    this.fastify.get("/v1/admin/providers/:id/usage", adminGuard, async (request) => {
      const id = parseInt((request.params as any).id, 10);
      const provider = this.providers.get(id);
      if (!provider) return { error: "not found" };
      return this.guard.getProviderKeyUsage(provider);
    });

    // ── Provider health check — send minimal request to test connectivity ──
    this.fastify.post("/v1/admin/providers/:id/test", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      const provider = this.providers.get(id);
      if (!provider) {
        return reply.code(404).send({ error: { message: "not found", type: "not_found", code: null } });
      }
      if (!provider.enabled) {
        return reply.code(400).send({ error: { message: "provider is disabled", type: "invalid_request", code: null } });
      }

      const body = request.body as { model?: string } | null;
      const models = this.providers.listModels(provider.id);
      const modelId = body?.model || models[0]?.modelId;
      if (!modelId) {
        return reply.code(400).send({ error: { message: "no models configured for this provider", type: "invalid_request", code: null } });
      }

      const decision = this.guard.tryAcquire(provider, 10);
      if (!decision.allowed || !decision.key) {
        return reply.code(429).send({ error: { message: `rate limit: ${decision.reason}`, type: "rate_limit_exceeded", code: null } });
      }

      const startTime = Date.now();
      try {
        const testBody: ChatCompletionRequest = {
          model: modelId,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
          stream: false,
        };
        const result = await this.proxy.forwardBuffered(provider, modelId, testBody, decision.key);
        const latency = Date.now() - startTime;
        this.guard.clearBackoff(decision.key.id);
        return { healthy: true, model: modelId, latencyMs: latency, response: result.response };
      } catch (err: any) {
        const latency = Date.now() - startTime;
        if (err instanceof ProxyError && err.statusCode === 429) {
          this.guard.markBackoff(decision.key.id);
        }
        return reply.code(502).send({
          healthy: false,
          model: modelId,
          latencyMs: latency,
          error: err.message,
          statusCode: err instanceof ProxyError ? err.statusCode : undefined,
        });
      }
    });

    // ── Test all providers (batch health check) ──
    this.fastify.post("/v1/admin/providers/test-all", adminGuard, async () => {
      const allProviders = this.providers.list().filter(p => p.enabled);
      const results: Array<{ providerId: number; providerName: string; healthy: boolean; model?: string; latencyMs?: number; error?: string }> = [];

      await Promise.allSettled(allProviders.map(async (provider) => {
        const models = this.providers.listModels(provider.id);
        const modelId = models[0]?.modelId;
        if (!modelId) {
          results.push({ providerId: provider.id, providerName: provider.name, healthy: false, error: "no models configured" });
          return;
        }
        const decision = this.guard.tryAcquire(provider, 10);
        if (!decision.allowed || !decision.key) {
          results.push({ providerId: provider.id, providerName: provider.name, healthy: false, error: `rate limit: ${decision.reason}` });
          return;
        }
        const startTime = Date.now();
        try {
          const testBody: ChatCompletionRequest = {
            model: modelId,
            messages: [{ role: "user", content: "Hi" }],
            max_tokens: 1,
            stream: false,
          };
          await this.proxy.forwardBuffered(provider, modelId, testBody, decision.key);
          this.guard.clearBackoff(decision.key.id);
          results.push({ providerId: provider.id, providerName: provider.name, healthy: true, model: modelId, latencyMs: Date.now() - startTime });
        } catch (err: any) {
          if (err instanceof ProxyError && err.statusCode === 429) {
            this.guard.markBackoff(decision.key.id);
          }
          results.push({ providerId: provider.id, providerName: provider.name, healthy: false, model: modelId, latencyMs: Date.now() - startTime, error: err.message });
        }
      }));

      return results;
    });

    // Tiers
    this.fastify.get("/v1/admin/tiers", adminGuard, async () => {
      return this.db.prepare("SELECT * FROM tiers ORDER BY id").all();
    });

    this.fastify.get("/v1/admin/tiers/:name/models", adminGuard, async (request) => {
      const name = (request.params as any).name;
      const tierRow = this.db.prepare("SELECT id FROM tiers WHERE name = ?").get(name) as { id: number } | undefined;
      if (!tierRow) return [];
      return this.db.prepare("SELECT * FROM tier_models WHERE tier_id = ? ORDER BY priority").all(tierRow.id);
    });

    this.fastify.put("/v1/admin/tiers/:name/models", adminGuard, async (request, reply) => {
      const name = (request.params as any).name;
      const tierRow = this.db.prepare("SELECT id FROM tiers WHERE name = ?").get(name) as { id: number } | undefined;
      if (!tierRow) return reply.code(404).send({ error: { message: "tier not found", type: "not_found", code: "null" } });

      const models = request.body as Array<{ modelId: string; providerId: number; priority: number }>;
      this.db.prepare("DELETE FROM tier_models WHERE tier_id = ?").run(tierRow.id);
      const stmt = this.db.prepare(
        "INSERT INTO tier_models (tier_id, model_id, provider_id, priority) VALUES (?, ?, ?, ?)"
      );
      for (const m of models) {
        stmt.run(tierRow.id, m.modelId, m.providerId, m.priority);
      }
      return { ok: true };
    });

    // ── Routing profiles ──

    this.fastify.get("/v1/admin/routing-profiles", adminGuard, async () => {
      return this.db.prepare("SELECT * FROM routing_profiles ORDER BY is_default DESC, name").all();
    });

    this.fastify.post("/v1/admin/routing-profiles", adminGuard, async (request, reply) => {
      const body = request.body as any;
      if (!body?.name) {
        return reply.code(400).send({ error: { message: "name is required", type: "invalid_request", code: null } });
      }
      const mode = body.mode ?? "auto";
      if (!["auto", "tier", "direct", "fusion"].includes(mode)) {
        return reply.code(400).send({ error: { message: "mode must be auto, tier, direct, or fusion", type: "invalid_request", code: null } });
      }
      // If setting as default, unset all others
      if (body.isDefault) {
        this.db.prepare("UPDATE routing_profiles SET is_default = 0").run();
      }
      const result = this.db.prepare(
        "INSERT INTO routing_profiles (name, description, mode, target, fallback_enabled, is_default) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        body.name,
        body.description ?? "",
        mode,
        body.target ?? null,
        body.fallbackEnabled === false ? 0 : 1,
        body.isDefault ? 1 : 0,
      );
      return reply.code(201).send({ id: Number(result.lastInsertRowid) });
    });

    this.fastify.put("/v1/admin/routing-profiles/:id", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      const body = request.body as any;
      const existing = this.db.prepare("SELECT * FROM routing_profiles WHERE id = ?").get(id);
      if (!existing) {
        return reply.code(404).send({ error: { message: "profile not found", type: "not_found", code: null } });
      }
      if (body.isDefault) {
        this.db.prepare("UPDATE routing_profiles SET is_default = 0").run();
      }
      this.db.prepare(
        "UPDATE routing_profiles SET name=?, description=?, mode=?, target=?, fallback_enabled=?, is_default=? WHERE id=?"
      ).run(
        body.name ?? (existing as any).name,
        body.description ?? (existing as any).description,
        body.mode ?? (existing as any).mode,
        body.target !== undefined ? body.target : (existing as any).target,
        body.fallbackEnabled === false ? 0 : 1,
        body.isDefault ? 1 : 0,
        id,
      );
      return { ok: true };
    });

    this.fastify.delete("/v1/admin/routing-profiles/:id", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      this.db.prepare("DELETE FROM routing_profiles WHERE id = ?").run(id);
      return { ok: true };
    });

    // Fusion pools
    this.fastify.get("/v1/admin/fusion-pools", adminGuard, async () => {
      return this.fusion.list();
    });

    this.fastify.post("/v1/admin/fusion-pools", adminGuard, async (request, reply) => {
      const body = request.body as any;
      try {
        const id = this.fusion.create(
          body.name,
          body.arbiterStrategy ?? "best_of_n",
          body.arbiterModelId,
        );
        return reply.code(201).send({ id });
      } catch (err: any) {
        return reply.code(400).send({ error: { message: err.message, type: "invalid_request", code: null } });
      }
    });

    this.fastify.put("/v1/admin/fusion-pools/:id", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      const body = request.body as any;
      const ok = this.fusion.update(id, body);
      return ok ? reply.send({ ok }) : reply.code(404).send({ error: { message: "not found", type: "not_found", code: null } });
    });

    this.fastify.delete("/v1/admin/fusion-pools/:id", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      const ok = this.fusion.delete(id);
      return ok ? reply.send({ ok }) : reply.code(404).send({ error: { message: "not found", type: "not_found", code: null } });
    });

    this.fastify.get("/v1/admin/fusion-pools/:id/members", adminGuard, async (request) => {
      const id = parseInt((request.params as any).id, 10);
      return this.fusion.listMembers(id);
    });

    this.fastify.put("/v1/admin/fusion-pools/:id/members", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      if (!this.fusion.get(id)) return reply.code(404).send({ error: { message: "not found", type: "not_found", code: null } });
      const members = request.body as Array<{ modelId: string; providerId: number; position: number }>;
      this.fusion.setMembers(id, members);
      return { ok: true };
    });

    // Models
    this.fastify.get("/v1/admin/models", adminGuard, async (request) => {
      const providerId = (request.query as any)?.providerId ? parseInt((request.query as any).providerId, 10) : undefined;
      return this.providers.listModels(providerId);
    });

    this.fastify.post("/v1/admin/models/sync", adminGuard, async () => {
      const result = await this.modelSync.sync();
      return result;
    });

    // Stats
    this.fastify.get("/v1/admin/stats", adminGuard, async (request) => {
      const days = parseInt((request.query as any)?.days ?? "30", 10);
      return this.usage.getSummary(days);
    });

    this.fastify.get("/v1/admin/stats/users", adminGuard, async (request) => {
      const days = parseInt((request.query as any)?.days ?? "30", 10);
      const summary = this.usage.getSummary(days);
      return summary.byUser;
    });

    this.fastify.get("/v1/admin/stats/providers", adminGuard, async (request) => {
      const days = parseInt((request.query as any)?.days ?? "30", 10);
      const summary = this.usage.getSummary(days);
      return summary.byProvider;
    });

    this.fastify.get("/v1/admin/stats/export", adminGuard, async (request, reply) => {
      const days = parseInt((request.query as any)?.days ?? "30", 10);
      const csv = this.usage.exportCsv(days);
      reply.header("Content-Type", "text/csv");
      reply.header("Content-Disposition", `attachment; filename="token-pool-usage-${days}d.csv"`);
      return csv;
    });

    // Request logs (paginated)
    this.fastify.get("/v1/admin/logs", adminGuard, async (request) => {
      const q = request.query as any;
      const limit = Math.min(parseInt(q?.limit ?? "50", 10), 200);
      const offset = parseInt(q?.offset ?? "0", 10);
      const providerId = q?.providerId ? parseInt(q.providerId, 10) : undefined;
      return this.usage.getLogs(limit, offset, providerId);
    });

    // ── Budget management ──
    this.fastify.get("/v1/admin/budgets", adminGuard, async () => {
      return this.usage.getAllBudgets();
    });

    this.fastify.get("/v1/admin/providers/:id/budget", adminGuard, async (request) => {
      const id = parseInt((request.params as any).id, 10);
      const budget = this.usage.getBudget(id);
      if (!budget) return null;
      const spend = this.usage.getProviderSpend(id);
      return { ...budget, dailySpend: spend.dailySpend, monthlySpend: spend.monthlySpend };
    });

    this.fastify.put("/v1/admin/providers/:id/budget", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      const body = request.body as { dailyLimitUsd?: number | null; monthlyLimitUsd?: number | null; alertThresholdPct?: number };
      this.usage.setBudget(id, body.dailyLimitUsd ?? null, body.monthlyLimitUsd ?? null, body.alertThresholdPct ?? 80);
      return { ok: true };
    });

    this.fastify.delete("/v1/admin/providers/:id/budget", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      this.usage.deleteBudget(id);
      return { ok: true };
    });

    // ── API Keys (virtual keys for external access) ──
    this.fastify.get("/v1/admin/api-keys", adminGuard, async () => {
      return this.db.prepare("SELECT id, label, user_id as userId, enabled, created_at as createdAt FROM api_keys ORDER BY id").all();
    });

    this.fastify.post("/v1/admin/api-keys", adminGuard, async (request, reply) => {
      const { label } = request.body as { label?: string };
      const rawKey = "tp-" + randomBytes(24).toString("hex");
      const { createHash } = await import("crypto");
      const keyHash = createHash("sha256").update(rawKey).digest("hex");
      const result = this.db.prepare("INSERT INTO api_keys (key_hash, label) VALUES (?, ?)").run(keyHash, label ?? "");
      return reply.code(201).send({ id: Number(result.lastInsertRowid), key: rawKey });
    });

    this.fastify.delete("/v1/admin/api-keys/:id", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
      return { ok: true };
    });

    this.fastify.put("/v1/admin/api-keys/:id/toggle", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      const row = this.db.prepare("SELECT enabled FROM api_keys WHERE id = ?").get(id) as { enabled: number } | undefined;
      if (!row) return reply.code(404).send({ error: { message: "not found", type: "not_found", code: null } });
      this.db.prepare("UPDATE api_keys SET enabled = ? WHERE id = ?").run(row.enabled ? 0 : 1, id);
      return { ok: true, enabled: !row.enabled };
    });

    // ── Cache stats ──
    this.fastify.get("/v1/admin/cache/stats", adminGuard, async () => {
      const total = this.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(hit_count), 0) as hits, COALESCE(SUM(input_tokens), 0) as inputTokens, COALESCE(SUM(output_tokens), 0) as outputTokens FROM response_cache").get() as any;
      const byModel = this.db.prepare("SELECT model_id as modelId, COUNT(*) as entries, SUM(hit_count) as hits FROM response_cache GROUP BY model_id ORDER BY hits DESC LIMIT 10").all();
      return { total: total.count, totalHits: total.hits, totalInputTokens: total.inputTokens, totalOutputTokens: total.outputTokens, byModel };
    });

    this.fastify.delete("/v1/admin/cache", adminGuard, async () => {
      this.db.prepare("DELETE FROM response_cache").run();
      return { ok: true };
    });

    // User management (admin only)
    this.fastify.get("/v1/admin/users", adminGuard, async () => {
      return this.users.list();
    });

    this.fastify.post("/v1/admin/users", adminGuard, async (request, reply) => {
      const { username, password, role } = request.body as { username: string; password: string; role?: "admin" | "regular" };
      if (!username || !password) {
        return reply.code(400).send({ error: { message: "username and password required", type: "invalid_request", code: null } });
      }
      try {
        const id = this.users.create(username, password, role ?? "regular");
        return reply.code(201).send({ id });
      } catch (err: any) {
        return reply.code(400).send({ error: { message: err.message, type: "invalid_request", code: null } });
      }
    });

    this.fastify.delete("/v1/admin/users/:id", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      const ok = this.users.delete(id);
      return ok ? reply.send({ ok }) : reply.code(404).send({ error: { message: "not found", type: "not_found", code: null } });
    });

    this.fastify.put("/v1/admin/users/:id/password", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      const { password } = request.body as { password: string };
      if (!password || password.length < 6) {
        return reply.code(400).send({ error: { message: "password must be at least 6 characters", type: "invalid_request", code: null } });
      }
      const ok = this.users.updatePassword(id, password);
      return ok ? reply.send({ ok }) : reply.code(404).send({ error: { message: "not found", type: "not_found", code: null } });
    });

    this.fastify.put("/v1/admin/users/:id/role", adminGuard, async (request, reply) => {
      const id = parseInt((request.params as any).id, 10);
      const { role } = request.body as { role: "admin" | "regular" };
      if (!role || !["admin", "regular"].includes(role)) {
        return reply.code(400).send({ error: { message: "role must be 'admin' or 'regular'", type: "invalid_request", code: null } });
      }
      const ok = this.users.updateRole(id, role);
      return ok ? reply.send({ ok }) : reply.code(404).send({ error: { message: "not found", type: "not_found", code: null } });
    });

    // ── OAuth ──

    // Start OAuth flow for a provider (routes based on flow type)
    this.fastify.post("/v1/admin/oauth/:provider/start", adminGuard, async (request, reply) => {
      const provider = (request.params as any).provider as string;
      const body = request.body as any;
      try {
        // If body has a token, store it directly (token paste flow)
        if (body?.token) {
          this.oauth.storeRawToken(provider, body.token, body?.scope);
          return reply.send({ success: true });
        }
        // Use the dispatcher to route to the correct flow
        const result = await this.oauth.startFlow(provider, body);
        return reply.send(result);
      } catch (err: any) {
        return reply.code(400).send({ error: { message: err.message, type: "oauth_error", code: null } });
      }
    });

    // Poll device flow for a provider (standard, MiniMax, Kiro)
    this.fastify.get("/v1/admin/oauth/:provider/poll", adminGuard, async (request, reply) => {
      const provider = (request.params as any).provider as string;
      const deviceCode = (request.query as any)?.device_code as string;
      if (!deviceCode) {
        return reply.code(400).send({ error: { message: "device_code query parameter required", type: "invalid_request", code: null } });
      }
      try {
        const result = await this.oauth.pollFlow(provider, deviceCode);
        return reply.send(result);
      } catch (err: any) {
        return reply.code(400).send({ error: { message: err.message, type: "oauth_error", code: null } });
      }
    });

    // Exchange authorization code manually (Anthropic paste, PKCE redirect fallback)
    this.fastify.post("/v1/admin/oauth/:provider/exchange", adminGuard, async (request, reply) => {
      const provider = (request.params as any).provider as string;
      const body = request.body as any;
      const code = body?.code as string;
      const state = body?.state as string | undefined;
      if (!code) {
        return reply.code(400).send({ error: { message: "code is required in request body", type: "invalid_request", code: null } });
      }
      try {
        const result = await this.oauth.exchangeCodeManual(provider, code, state);
        return reply.send(result);
      } catch (err: any) {
        return reply.code(400).send({ error: { message: err.message, type: "oauth_error", code: null } });
      }
    });

    // Web flow callback
    this.fastify.get("/v1/admin/oauth/:provider/callback", adminGuard, async (request, reply) => {
      const provider = (request.params as any).provider as string;
      const query = request.query as any;
      const code = query?.code as string;
      const state = query?.state as string;

      if (!code || !state) {
        return reply.code(400).send({ error: { message: "code and state query parameters required", type: "invalid_request", code: null } });
      }

      // Validate state
      const pending = this.oauth.consumeState(state);
      if (!pending) {
        return reply.code(400).send({ error: { message: "Invalid or expired state parameter", type: "oauth_error", code: null } });
      }

      try {
        const result = await this.oauth.exchangeCode(pending.providerName, code, pending.redirectUri);
        return reply.send(result);
      } catch (err: any) {
        return reply.code(400).send({ error: { message: err.message, type: "oauth_error", code: null } });
      }
    });

    // List connected OAuth tokens (masked)
    this.fastify.get("/v1/admin/oauth/tokens", adminGuard, async () => {
      return this.oauth.listTokens();
    });

    // Disconnect a provider's OAuth
    this.fastify.delete("/v1/admin/oauth/:provider", adminGuard, async (request, reply) => {
      const provider = (request.params as any).provider as string;
      const ok = this.oauth.disconnect(provider);
      return ok ? reply.send({ ok }) : reply.code(404).send({ error: { message: "not found", type: "not_found", code: null } });
    });
  }

  async stop() {
    this.modelSync.stop();
    await this.fastify.close();
    this.db.close();
  }
}

/**
 * Count output tokens from SSE stream chunks.
 * Parses "data:" lines as JSON and counts content delta length / 4.
 */
function countStreamTokens(chunk: Uint8Array): number {
  const text = Buffer.from(chunk).toString("utf8");
  let tokens = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      const content = parsed?.choices?.[0]?.delta?.content;
      if (typeof content === "string") {
        tokens += Math.ceil(content.length / 4);
      }
    } catch {
      // not valid JSON, skip
    }
  }
  return tokens;
}
