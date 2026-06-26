import type { Provider, ProviderKey, ModelMetadata, WireFormat } from "@/types";
import type { DatabaseService } from "@/db";

// ── Row mappers (snake_case DB → camelCase TS) ──

interface ProviderRow {
  id: number; name: string; base_url: string; type: "free" | "paid" | "local" | "subscription"; wire_format: string;
  rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null;
  max_concurrent_requests: number | null;
  enabled: number; created_at: string;
}

interface KeyRow {
  id: number; provider_id: number; label: string; api_key_enc: string;
  rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null;
  rr_position: number; enabled: number; created_at: string;
}

interface ModelRow {
  id: number; provider_id: number; model_id: string; name: string;
  context_window: number; supports_vision: number; supports_audio: number; supports_tools: number;
  input_cost_per_mtok: number | null; output_cost_per_mtok: number | null; max_output_tokens: number | null;
  fetched_at: string;
}

function mapProvider(r: ProviderRow): Provider {
  return {
    id: r.id, name: r.name, baseUrl: r.base_url, type: r.type,
    wireFormat: r.wire_format as WireFormat,
    rpmLimit: r.rpm_limit, rpdLimit: r.rpd_limit, tpmLimit: r.tpm_limit, tpdLimit: r.tpd_limit,
    maxConcurrentRequests: r.max_concurrent_requests,
    enabled: r.enabled === 1, createdAt: r.created_at,
  };
}

function mapKey(r: KeyRow): ProviderKey {
  return {
    id: r.id, providerId: r.provider_id, label: r.label, apiKeyEnc: r.api_key_enc,
    rpmLimit: r.rpm_limit, rpdLimit: r.rpd_limit, tpmLimit: r.tpm_limit, tpdLimit: r.tpd_limit,
    rrPosition: r.rr_position, enabled: r.enabled === 1, createdAt: r.created_at,
  };
}

function mapModel(r: ModelRow): ModelMetadata {
  return {
    id: r.id, providerId: r.provider_id, modelId: r.model_id, name: r.name,
    contextWindow: r.context_window,
    supportsVision: r.supports_vision === 1, supportsAudio: r.supports_audio === 1,
    supportsTools: r.supports_tools === 1,
    inputCostPerMtok: r.input_cost_per_mtok, outputCostPerMtok: r.output_cost_per_mtok,
    maxOutputTokens: r.max_output_tokens, fetchedAt: r.fetched_at,
  };
}

export class ProviderService {
  constructor(private db: DatabaseService) {}

  // ── Providers ──

  list(): Provider[] {
    return (this.db.prepare("SELECT * FROM providers ORDER BY id").all() as ProviderRow[]).map(mapProvider);
  }

  get(id: number): Provider | undefined {
    const r = this.db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as ProviderRow | undefined;
    return r ? mapProvider(r) : undefined;
  }

  getByName(name: string): Provider | undefined {
    const r = this.db.prepare("SELECT * FROM providers WHERE name = ?").get(name) as ProviderRow | undefined;
    return r ? mapProvider(r) : undefined;
  }

  create(p: Omit<Provider, "id" | "createdAt">): number {
    const stmt = this.db.prepare(
      `INSERT INTO providers (name, base_url, type, wire_format, rpm_limit, rpd_limit, tpm_limit, tpd_limit, max_concurrent_requests, enabled)
       VALUES (@name, @base_url, @type, @wire_format, @rpm_limit, @rpd_limit, @tpm_limit, @tpd_limit, @max_concurrent_requests, @enabled)`
    );
    const result = stmt.run({
      name: p.name,
      base_url: p.baseUrl,
      type: p.type,
      wire_format: p.wireFormat ?? "openai",
      rpm_limit: p.rpmLimit,
      rpd_limit: p.rpdLimit,
      tpm_limit: p.tpmLimit,
      tpd_limit: p.tpdLimit,
      max_concurrent_requests: p.maxConcurrentRequests ?? null,
      enabled: p.enabled ? 1 : 0,
    });
    return Number(result.lastInsertRowid);
  }

  update(id: number, p: Partial<Provider>): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    const merged = { ...existing, ...p };
    this.db.prepare(
      `UPDATE providers SET name=?, base_url=?, type=?, wire_format=?, rpm_limit=?, rpd_limit=?, tpm_limit=?, tpd_limit=?, max_concurrent_requests=?, enabled=? WHERE id=?`
    ).run(
      merged.name, merged.baseUrl, merged.type, merged.wireFormat,
      merged.rpmLimit, merged.rpdLimit, merged.tpmLimit, merged.tpdLimit,
      merged.maxConcurrentRequests, merged.enabled ? 1 : 0, id
    );
    return true;
  }

  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ── Keys ──

  listKeys(providerId: number): ProviderKey[] {
    return (this.db.prepare("SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY rr_position").all(providerId) as KeyRow[]).map(mapKey);
  }

  getKey(id: number): ProviderKey | undefined {
    const r = this.db.prepare("SELECT * FROM provider_keys WHERE id = ?").get(id) as KeyRow | undefined;
    return r ? mapKey(r) : undefined;
  }

  addKey(providerId: number, label: string, apiKeyEnc: string, limits?: Partial<Pick<ProviderKey, "rpmLimit" | "rpdLimit" | "tpmLimit" | "tpdLimit">>): number {
    const count = this.listKeys(providerId).length;
    const stmt = this.db.prepare(
      `INSERT INTO provider_keys (provider_id, label, api_key_enc, rpm_limit, rpd_limit, tpm_limit, tpd_limit, rr_position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      providerId, label, apiKeyEnc,
      limits?.rpmLimit ?? null, limits?.rpdLimit ?? null,
      limits?.tpmLimit ?? null, limits?.tpdLimit ?? null,
      count
    );
    return Number(result.lastInsertRowid);
  }

  deleteKey(id: number): boolean {
    const result = this.db.prepare("DELETE FROM provider_keys WHERE id = ?").run(id);
    return result.changes > 0;
  }

  updateKeyLimits(id: number, limits: Partial<Pick<ProviderKey, "rpmLimit" | "rpdLimit" | "tpmLimit" | "tpdLimit">>): boolean {
    const result = this.db.prepare(
      `UPDATE provider_keys SET rpm_limit=?, rpd_limit=?, tpm_limit=?, tpd_limit=? WHERE id=?`
    ).run(limits.rpmLimit ?? null, limits.rpdLimit ?? null, limits.tpmLimit ?? null, limits.tpdLimit ?? null, id);
    return result.changes > 0;
  }

  // ── Models ──

  listModels(providerId?: number): ModelMetadata[] {
    const rows = providerId
      ? this.db.prepare("SELECT * FROM models WHERE provider_id = ?").all(providerId) as ModelRow[]
      : this.db.prepare("SELECT * FROM models").all() as ModelRow[];
    return rows.map(mapModel);
  }

  getModel(modelId: string): ModelMetadata | undefined {
    const r = this.db.prepare("SELECT * FROM models WHERE model_id = ?").get(modelId) as ModelRow | undefined;
    return r ? mapModel(r) : undefined;
  }

  upsertModel(m: Omit<ModelMetadata, "id" | "fetchedAt">): void {
    this.db.prepare(
      `INSERT INTO models (provider_id, model_id, name, context_window, supports_vision, supports_audio, supports_tools, input_cost_per_mtok, output_cost_per_mtok, max_output_tokens)
       VALUES (@provider_id, @model_id, @name, @context_window, @supports_vision, @supports_audio, @supports_tools, @input_cost_per_mtok, @output_cost_per_mtok, @max_output_tokens)
       ON CONFLICT(provider_id, model_id) DO UPDATE SET
         name=@name, context_window=@context_window, supports_vision=@supports_vision,
         supports_audio=@supports_audio, supports_tools=@supports_tools,
         input_cost_per_mtok=@input_cost_per_mtok, output_cost_per_mtok=@output_cost_per_mtok,
         max_output_tokens=@max_output_tokens, fetched_at=datetime('now')`
    ).run({
      provider_id: m.providerId,
      model_id: m.modelId,
      name: m.name,
      context_window: m.contextWindow,
      supports_vision: m.supportsVision ? 1 : 0,
      supports_audio: m.supportsAudio ? 1 : 0,
      supports_tools: m.supportsTools ? 1 : 0,
      input_cost_per_mtok: m.inputCostPerMtok,
      output_cost_per_mtok: m.outputCostPerMtok,
      max_output_tokens: m.maxOutputTokens,
    });
  }
}
