import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { randomBytes } from "crypto";
import { loadConfig, type AppConfig } from "@/config";
import { DatabaseService } from "@/db";
import { CryptoService } from "@/auth/crypto";
import { ProviderService } from "@/providers";
import { ProviderProxy, ProxyError } from "@/providers/proxy";
import { RateLimitGuard } from "@/providers/rate-limiter";
import { ModelMetadataSync } from "@/providers/model-sync";
import { FusionService } from "@/fusion";
import { UserService } from "@/auth/user-service";
import { registerAuth, setupAuthGuards, signToken, type JwtPayload } from "@/auth/middleware";
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
  private fusion: FusionService;
  private modelSync: ModelMetadataSync;
  private users: UserService;
  private config: AppConfig;

  constructor() {
    this.config = loadConfig();
    this.ensureSecret();

    this.db = new DatabaseService(this.config.databaseUrl);
    this.crypto = new CryptoService(this.config.appSecret);
    this.providers = new ProviderService(this.db);
    this.proxy = new ProviderProxy(this.providers, this.crypto);
    this.guard = new RateLimitGuard(this.db, this.providers);
    this.fusion = new FusionService(this.db);
    this.modelSync = new ModelMetadataSync(this.providers, this.config.modelsRefreshIntervalSec);
    this.users = new UserService(this.db);

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

    // ── List models ──
    this.fastify.get("/v1/models", async () => {
      const dbModels = this.providers.listModels();
      const data = dbModels.map(m => ({
        id: m.modelId,
        object: "model" as const,
        created: 0,
        owned_by: m.providerId.toString(),
      }));
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

      // Check for fusion trigger
      if (body.model.startsWith("fusion:")) {
        return reply.code(501).send({
          error: { message: "Fusion engine not yet implemented", type: "not_implemented", code: null },
        });
      }

      // Check for explicit model (direct passthrough)
      if (body.model.includes("/")) {
        return await this.handleDirectRoute(body, reply);
      }

      // Tier-based routing
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

      // Try each model in the fallback chain
      for (const resolved of chain) {
        try {
          return await this.handleProxy(body, resolved, reply);
        } catch (err: any) {
          // On 429, mark the key as backed off and try next
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
    });

    this.registerAdminRoutes();
  }

  private async handleDirectRoute(body: ChatCompletionRequest, reply: any) {
    const allModels = this.providers.listModels();
    const model = allModels.find(m => m.modelId === body.model);
    if (!model) {
      return reply.code(404).send({
        error: { message: `Model '${body.model}' not found`, type: "not_found", code: null },
      });
    }

    const provider = this.providers.get(model.providerId);
    if (!provider || !provider.enabled) {
      return reply.code(503).send({
        error: { message: "Provider not available", type: "no_provider", code: null },
      });
    }

    const estTokens = estimateTokens(body) + (body.max_tokens ?? 1000);
    const decision = this.guard.tryAcquire(provider, estTokens);
    if (!decision.allowed || !decision.key) {
      return reply.code(429).send({
        error: {
          message: `Rate limit exceeded for ${provider.name}: ${decision.reason}`,
          type: "rate_limit_exceeded",
          code: null,
        },
      });
    }

    const resolved: ResolvedModel = {
      modelId: body.model,
      provider,
      key: decision.key,
    };

    return await this.handleProxy(body, resolved, reply);
  }

  private async handleProxy(body: ChatCompletionRequest, resolved: ResolvedModel, reply: any) {
    const result = await this.proxy.forward(resolved.provider, resolved.modelId, body, resolved.key);

    if (result.status === 429) {
      this.guard.markBackoff(resolved.key.id);
      throw new ProxyError(`Upstream 429 from ${resolved.provider.name}`, 429);
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

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(Buffer.from(value));
        }
      } catch (err) {
        this.fastify.log.error({ err }, "Stream error");
      } finally {
        writer.end();
      }
      return reply;
    }

    // Buffered response
    const text = typeof result.body === "string"
      ? result.body
      : await new Response(result.body as any).text();

    const data = JSON.parse(text);
    reply.header("x-resolved-model", resolved.modelId);
    return reply.send(data);
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
          rpmLimit: body.rpmLimit ?? null,
          rpdLimit: body.rpdLimit ?? null,
          tpmLimit: body.tpmLimit ?? null,
          tpdLimit: body.tpdLimit ?? null,
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
    this.fastify.get("/v1/admin/stats", adminGuard, async () => {
      const total = this.db.prepare(
        "SELECT COUNT(*) as count, COALESCE(SUM(input_tokens), 0) as input_tokens, COALESCE(SUM(output_tokens), 0) as output_tokens FROM usage_events"
      ).get();
      const byProvider = this.db.prepare(
        `SELECT provider_id, COUNT(*) as count, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens
         FROM usage_events GROUP BY provider_id ORDER BY count DESC`
      ).all();
      const byTier = this.db.prepare(
        `SELECT tier, COUNT(*) as count, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens
         FROM usage_events GROUP BY tier ORDER BY count DESC`
      ).all();
      return { total, byProvider, byTier };
    });

    this.fastify.get("/v1/admin/stats/users", adminGuard, async () => {
      return this.db.prepare(
        `SELECT user_id, COUNT(*) as count, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens
         FROM usage_events GROUP BY user_id ORDER BY count DESC`
      ).all();
    });

    this.fastify.get("/v1/admin/stats/providers", adminGuard, async () => {
      return this.db.prepare(
        `SELECT provider_id, COUNT(*) as count, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens
         FROM usage_events GROUP BY provider_id ORDER BY count DESC`
      ).all();
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
  }

  async stop() {
    this.modelSync.stop();
    await this.fastify.close();
    this.db.close();
  }
}
