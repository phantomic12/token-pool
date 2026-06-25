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
  type TEXT NOT NULL DEFAULT 'free',
  rpm_limit INTEGER,
  rpd_limit INTEGER,
  tpm_limit INTEGER,
  tpd_limit INTEGER,
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
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
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
`;

const SEED_TIERS = [
  ["simple", "Short Q&A, chat, classification"],
  ["standard", "General assistant tasks"],
  ["reasoning", "Chain-of-thought, math, logic"],
  ["complex", "Long synthesis, research, multi-step"],
  ["multimodal", "Image/audio/video input"],
];

// Free provider seeded defaults
const SEED_PROVIDERS = [
  // name, base_url, type, rpm, rpd, tpm, tpd
  ["openrouter-free", "https://openrouter.ai/api/v1", "free", 20, 1000, null, null],
  ["google-aistudio", "https://generativelanguage.googleapis.com/v1beta/openai", "free", 15, 1500, 250000, null],
  ["groq", "https://api.groq.com/openai/v1", "free", 30, 1000, 12000, 100000],
  ["cerebras", "https://api.cerebras.ai/v1", "free", null, null, null, 1000000],
  ["mistral-experiment", "https://api.mistral.ai/v1", "free", null, null, null, null],
  ["github-models", "https://models.inference.ai.azure.com", "free", null, null, null, null],
  ["cohere-trial", "https://api.cohere.ai/v1", "free", null, null, null, null],
];

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
    this.seedDefaults();
  }

  private seedDefaults() {
    const tierStmt = this.db.prepare("INSERT OR IGNORE INTO tiers (name, description) VALUES (?, ?)");
    for (const [name, desc] of SEED_TIERS) {
      tierStmt.run(name, desc);
    }

    const provStmt = this.db.prepare(
      `INSERT OR IGNORE INTO providers (name, base_url, type, rpm_limit, rpd_limit, tpm_limit, tpd_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
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
