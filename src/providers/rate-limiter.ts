import type { DatabaseService } from "@/db";
import type { ProviderService } from "@/providers";
import type { ProviderKey, Provider } from "@/types";

export interface RateLimitDecision {
  allowed: boolean;
  key: ProviderKey | null;
  reason: string;
  retryAfterSec?: number;
}

export interface QuotaUsage {
  rpmUsed: number;
  rpdUsed: number;
  tpmUsed: number;
  tpdUsed: number;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
}

// Backoff tracking lives on the instance so it resets per guard (and per test).

export class RateLimitGuard {
  private backoffMap = new Map<number, number>();

  constructor(
    private db: DatabaseService,
    private providers: ProviderService,
  ) {}

  /**
   * Try to acquire a permit for a request on the given provider.
   * Walks enabled keys in round-robin order, skipping any that are:
   *   - in a backoff window (recently got 429)
   *   - exhausted on RPM/RPD/TPM/TPD quotas
   * Returns the first available key, or null if all exhausted.
   */
  tryAcquire(provider: Provider, estTokens: number): RateLimitDecision {
    const keys = this.providers.listKeys(provider.id).filter(k => k.enabled);
    if (keys.length === 0) {
      return { allowed: false, key: null, reason: "no keys configured for provider" };
    }

    const now = Date.now();

    for (const key of keys) {
      // Skip if in backoff window
      const backoffUntil = this.backoffMap.get(key.id);
      if (backoffUntil && backoffUntil > now) {
        continue;
      }
      // Backoff expired — clean up
      if (backoffUntil) {
        this.backoffMap.delete(key.id);
      }

      const usage = this.getUsage(key, provider);
      const limits = this.resolveLimits(key, provider);

      // Check each quota bucket
      if (limits.rpm !== null && usage.rpmUsed >= limits.rpm) continue;
      if (limits.rpd !== null && usage.rpdUsed >= limits.rpd) continue;
      if (limits.tpm !== null && usage.tpmUsed + estTokens > limits.tpm) continue;
      if (limits.tpd !== null && usage.tpdUsed + estTokens > limits.tpd) continue;

      // Acquire — increment counters
      this.incrementUsage(key.id, estTokens);
      return { allowed: true, key, reason: "acquired" };
    }

    // All keys exhausted — check if any are in backoff (for retry-after)
    let minRetry = Infinity;
    for (const key of keys) {
      const backoffUntil = this.backoffMap.get(key.id);
      if (backoffUntil && backoffUntil > now) {
        minRetry = Math.min(minRetry, backoffUntil - now);
      }
    }

    return {
      allowed: false,
      key: null,
      reason: "all keys exhausted or in backoff",
      retryAfterSec: minRetry !== Infinity ? Math.ceil(minRetry / 1000) : undefined,
    };
  }

  /**
   * Mark a key as rate-limited (called on upstream 429).
   * Adds jittered backoff so we don't hammer the key.
   */
  markBackoff(keyId: number, retryAfterSec?: number): void {
    // Use Retry-After header if provided, else default with jitter
    const base = retryAfterSec ?? 60;
    const jitter = Math.floor(Math.random() * 5); // 0-4s jitter
    const backoffMs = (base + jitter) * 1000;
    this.backoffMap.set(keyId, Date.now() + backoffMs);
  }

  /**
   * Clear backoff for a key (called on successful response).
   */
  clearBackoff(keyId: number): void {
    this.backoffMap.delete(keyId);
  }

  /**
   * Get current quota usage for a key.
   */
  getUsage(key: ProviderKey, provider: Provider): QuotaUsage {
    const now = new Date();
    const minuteStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()).toISOString();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    const minuteRow = this.db.prepare(
      "SELECT requests_used, tokens_used FROM rate_limit_state WHERE key_id=? AND window_type='minute' AND window_start=?"
    ).get(key.id, minuteStart) as { requests_used: number; tokens_used: number } | undefined;

    const dayRow = this.db.prepare(
      "SELECT requests_used, tokens_used FROM rate_limit_state WHERE key_id=? AND window_type='day' AND window_start=?"
    ).get(key.id, dayStart) as { requests_used: number; tokens_used: number } | undefined;

    const limits = this.resolveLimits(key, provider);

    return {
      rpmUsed: minuteRow?.requests_used ?? 0,
      rpdUsed: dayRow?.requests_used ?? 0,
      tpmUsed: minuteRow?.tokens_used ?? 0,
      tpdUsed: dayRow?.tokens_used ?? 0,
      rpmLimit: limits.rpm,
      rpdLimit: limits.rpd,
      tpmLimit: limits.tpm,
      tpdLimit: limits.tpd,
    };
  }

  /**
   * Get usage for all keys of a provider (for WebUI display).
   */
  getProviderKeyUsage(provider: Provider): Array<{ key: ProviderKey; usage: QuotaUsage; inBackoff: boolean; backoffRemainingSec?: number }> {
    const keys = this.providers.listKeys(provider.id);
    const now = Date.now();
    return keys.map(key => {
      const backoffUntil = this.backoffMap.get(key.id);
      const inBackoff = backoffUntil !== undefined && backoffUntil > now;
      return {
        key,
        usage: this.getUsage(key, provider),
        inBackoff,
        backoffRemainingSec: inBackoff ? Math.ceil((backoffUntil! - now) / 1000) : undefined,
      };
    });
  }

  // ── Internal ──

  private resolveLimits(key: ProviderKey, provider: Provider): { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null } {
    // Per-key override if set, else inherit from provider
    return {
      rpm: key.rpmLimit ?? provider.rpmLimit,
      rpd: key.rpdLimit ?? provider.rpdLimit,
      tpm: key.tpmLimit ?? provider.tpmLimit,
      tpd: key.tpdLimit ?? provider.tpdLimit,
    };
  }

  private incrementUsage(keyId: number, tokens: number): void {
    const now = new Date();
    const minuteStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()).toISOString();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    // Upsert minute window
    this.db.prepare(
      `INSERT INTO rate_limit_state (key_id, window_type, window_start, requests_used, tokens_used)
       VALUES (?, 'minute', ?, 1, ?)
       ON CONFLICT(key_id, window_type, window_start) DO UPDATE SET
         requests_used = requests_used + 1,
         tokens_used = tokens_used + ?`
    ).run(keyId, minuteStart, tokens, tokens);

    // Upsert day window
    this.db.prepare(
      `INSERT INTO rate_limit_state (key_id, window_type, window_start, requests_used, tokens_used)
       VALUES (?, 'day', ?, 1, ?)
       ON CONFLICT(key_id, window_type, window_start) DO UPDATE SET
         requests_used = requests_used + 1,
         tokens_used = tokens_used + ?`
    ).run(keyId, dayStart, tokens, tokens);
  }
}
