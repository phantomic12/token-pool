import Database from "better-sqlite3";
import type { Database as DB, Statement } from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'regular',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  base_url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'free',  -- category: free | paid | local | subscription
  wire_format TEXT NOT NULL DEFAULT 'openai',
  rpm_limit INTEGER,
  rpd_limit INTEGER,
  tpm_limit INTEGER,
  tpd_limit INTEGER,
  max_concurrent_requests INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,
  rpm_limit INTEGER,
  rpd_limit INTEGER,
  tpm_limit INTEGER,
  tpd_limit INTEGER,
  rr_position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  name TEXT NOT NULL,
  context_window INTEGER DEFAULT 0,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_audio INTEGER NOT NULL DEFAULT 0,
  supports_tools INTEGER NOT NULL DEFAULT 0,
  input_cost_per_mtok REAL,
  output_cost_per_mtok REAL,
  max_output_tokens INTEGER,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tier_models (
  tier_id INTEGER NOT NULL REFERENCES tiers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  priority INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fusion_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  arbiter_strategy TEXT NOT NULL DEFAULT 'best_of_n',
  arbiter_model_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fusion_pool_members (
  pool_id INTEGER NOT NULL REFERENCES fusion_pools(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider_id INTEGER,
  model_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  fusion_pool_id INTEGER,
  cost_usd REAL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_limit_state (
  key_id INTEGER NOT NULL REFERENCES provider_keys(id) ON DELETE CASCADE,
  window_type TEXT NOT NULL,
  window_start TEXT NOT NULL,
  requests_used INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  UNIQUE(key_id, window_type, window_start)
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  scope TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routing_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'auto',           -- auto | tier | direct | fusion
  target TEXT,                                   -- modelId for direct, tier name for tier, pool name for fusion
  fallback_enabled INTEGER NOT NULL DEFAULT 1,  -- on failure, try fallback chain
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const SEED_TIERS = [
  ["simple", "Short Q&A, chat, classification"],
  ["standard", "General assistant tasks"],
  ["reasoning", "Chain-of-thought, math, logic"],
  ["complex", "Long synthesis, research, multi-step"],
  ["multimodal", "Image/audio/video input"],
];

// Full provider list — wire formats from manifest's provider-endpoints.ts,
// rate limits from cheahjs/free-llm-api-resources.
// Fields: name, base_url, category, wire_format, rpm, rpd, tpm, tpd
const SEED_PROVIDERS: [string, string, string, string, number | null, number | null, number | null, number | null][] = [
  // ── Free tier (no payment required) ──
  ["openrouter", "https://openrouter.ai/api/v1", "free", "openai", 20, 1000, null, null],
  ["google", "https://generativelanguage.googleapis.com/v1beta/openai", "free", "openai", 15, 1500, 250000, null],
  ["groq", "https://api.groq.com/openai/v1", "free", "openai", 30, 1000, 12000, 100000],
  ["cerebras", "https://api.cerebras.ai/v1", "free", "openai", 30, 14400, 60000, 1000000],
  ["mistral", "https://api.mistral.ai/v1", "free", "openai", 1, null, 500000, null],
  ["github-models", "https://models.inference.ai.azure.com", "free", "openai", null, null, null, null],
  ["cohere", "https://api.cohere.ai/v1", "free", "openai", 20, null, null, 1000],
  ["cloudflare", "https://api.cloudflare.com/client/v4/accounts", "free", "openai", null, null, null, null],
  ["huggingface", "https://api-inference.huggingface.co", "free", "openai", null, null, null, null],
  ["nvidia", "https://integrate.api.nvidia.com/v1", "free", "openai", 40, null, null, null],
  ["sambanova", "https://api.sambanova.ai/v1", "free", "openai", null, null, null, null],

  // ── Paid (commercial, pay-per-use) ──
  ["openai", "https://api.openai.com/v1", "paid", "openai", null, null, null, null],
  ["anthropic", "https://api.anthropic.com", "paid", "anthropic", null, null, null, null],
  ["deepseek", "https://api.deepseek.com/v1", "paid", "openai", null, null, null, null],
  ["xai", "https://api.x.ai/v1", "paid", "openai", null, null, null, null],
  ["minimax", "https://api.minimax.io/v1", "paid", "openai", null, null, null, null],
  ["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "paid", "openai", null, null, null, null],
  ["moonshot", "https://api.moonshot.ai/v1", "paid", "openai", null, null, null, null],
  ["zai", "https://api.z.ai/api/paas/v4", "paid", "openai", null, null, null, null],
  ["xiaomi", "https://api.xiaomimimo.com/v1", "paid", "openai", null, null, null, null],
  ["fireworks", "https://api.fireworks.ai/inference/v1", "paid", "openai", null, null, null, null],
  ["bedrock", "https://bedrock-runtime.us-east-1.amazonaws.com", "paid", "openai", null, null, null, null],
  ["byteplus", "https://ark.ap-southeast.bytepluses.com/api/coding/v3", "paid", "openai", null, null, null, null],
  ["commandcode", "https://api.commandcode.ai/provider/v1", "paid", "openai", null, null, null, null],

  // ── Local (self-hosted inference) ──
  ["ollama", "http://localhost:11434/v1", "local", "openai", null, null, null, null],
  ["llamacpp", "http://localhost:8080/v1", "local", "openai", null, null, null, null],
  ["lmstudio", "http://localhost:1234/v1", "local", "openai", null, null, null, null],

  // ── Paid (coding-focused inference providers) ──
  ["umans", "https://api.code.umans.ai/v1", "paid", "openai", null, null, null, null],
];

// Migration: add wire_format column to existing providers table if missing
const MIGRATION_ADD_WIRE_FORMAT = `
ALTER TABLE providers ADD COLUMN wire_format TEXT NOT NULL DEFAULT 'openai';
`;

export class DatabaseService {
  private db: DB;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  private init() {
    this.db.exec(SCHEMA);
    this.migrate();
    this.seedDefaults();
    this.postSeedMigrate();
  }

  private migrate() {
    // Check if wire_format column exists
    const cols = this.db.prepare("PRAGMA table_info(providers)").all() as { name: string }[];
    if (!cols.some(c => c.name === "wire_format")) {
      this.db.exec(MIGRATION_ADD_WIRE_FORMAT);
    }

    // Check if max_concurrent_requests column exists
    if (!cols.some(c => c.name === "max_concurrent_requests")) {
      this.db.exec("ALTER TABLE providers ADD COLUMN max_concurrent_requests INTEGER");
    }

    // Migrate local providers from "free" to "local" category
    this.db.exec("UPDATE providers SET type = 'local' WHERE name IN ('ollama', 'llamacpp', 'lmstudio') AND type = 'free'");

    // Check if models table has UNIQUE constraint on (provider_id, model_id)
    // SQLite can't alter constraints in-place, so recreate if missing
    const indexes = this.db.prepare("PRAGMA index_list(models)").all() as { name: string; origin: string }[];
    const hasUnique = indexes.some(i => i.origin === "u" || i.name === "sqlite_autoindex_models_2");
    if (!hasUnique) {
      // Recreate models table with the constraint
      this.db.exec("DROP TABLE IF EXISTS models");
      this.db.exec(`
        CREATE TABLE models (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider_id INTEGER REFERENCES providers(id) ON DELETE CASCADE,
          model_id TEXT NOT NULL,
          name TEXT NOT NULL,
          context_window INTEGER DEFAULT 0,
          supports_vision INTEGER NOT NULL DEFAULT 0,
          supports_audio INTEGER NOT NULL DEFAULT 0,
          supports_tools INTEGER NOT NULL DEFAULT 0,
          input_cost_per_mtok REAL,
          output_cost_per_mtok REAL,
          max_output_tokens INTEGER,
          fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(provider_id, model_id)
        )
      `);
    }
  }

  /** Runs after seed to fix categories that INSERT OR IGNORE skipped */
  private postSeedMigrate() {
    // Ensure local providers have correct category even if they existed before
    this.db.exec("UPDATE providers SET type = 'local' WHERE name IN ('ollama', 'llamacpp', 'lmstudio') AND type = 'free'");

    // Set concurrency limit for umans (default 4, expandable by buying more capacity)
    this.db.exec("UPDATE providers SET max_concurrent_requests = 4 WHERE name = 'umans' AND max_concurrent_requests IS NULL");

    // Fix umans base URL + category (was incorrectly seeded as subscription)
    this.db.exec("UPDATE providers SET base_url = 'https://api.code.umans.ai/v1', type = 'paid' WHERE name = 'umans'");
  }

  private seedDefaults() {
    const tierStmt = this.db.prepare("INSERT OR IGNORE INTO tiers (name, description) VALUES (?, ?)");
    for (const [name, desc] of SEED_TIERS) {
      tierStmt.run(name, desc);
    }

    const provStmt = this.db.prepare(
      `INSERT OR IGNORE INTO providers (name, base_url, type, wire_format, rpm_limit, rpd_limit, tpm_limit, tpd_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of SEED_PROVIDERS) {
      provStmt.run(...p);
    }
  }

  prepare(sql: string): Statement {
    return this.db.prepare(sql);
  }

  exec(sql: string) {
    this.db.exec(sql);
  }

  close() {
    this.db.close();
  }
}
