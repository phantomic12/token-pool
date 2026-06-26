/**
 * ConcurrencyGuard — per-provider in-flight request semaphore.
 *
 * Distinct from RateLimitGuard (which tracks windowed RPM/RPD/TPM/TPD quotas).
 * This enforces a hard ceiling on *concurrent in-flight* requests per provider.
 * When the limit is exceeded, returns 429 with Retry-After hint.
 *
 * Used for providers like "umans" that enforce concurrency limits
 * (expandable by purchasing more capacity).
 */

export interface ConcurrencyDecision {
  allowed: boolean;
  reason: string;
  retryAfterSec?: number;
}

export class ConcurrencyGuard {
  // providerId → current in-flight count
  private inflight = new Map<number, number>();
  // providerId → max concurrent (cached from DB, refreshable)
  private limits = new Map<number, number | null>();

  /**
   * Refresh the concurrency limit for a provider from its DB row.
   * Called when providers are created/updated.
   */
  setLimit(providerId: number, maxConcurrent: number | null): void {
    this.limits.set(providerId, maxConcurrent);
    if (maxConcurrent === null) {
      this.inflight.delete(providerId);
    }
  }

  /**
   * Try to acquire a concurrency slot for a provider.
   * Returns allowed=true if a slot was acquired (or no limit is set).
   * Returns allowed=false with 429 semantics if the limit is exceeded.
   */
  tryAcquire(providerId: number, maxConcurrent: number | null): ConcurrencyDecision {
    // No limit set — always allow
    if (maxConcurrent === null || maxConcurrent === undefined || maxConcurrent <= 0) {
      return { allowed: true, reason: "no concurrency limit" };
    }

    const current = this.inflight.get(providerId) ?? 0;
    if (current >= maxConcurrent) {
      // Estimate retry-after: assume avg request ~30s, so position in queue * 30
      const queuePosition = current - maxConcurrent + 1;
      const retryAfterSec = Math.min(60, Math.max(5, queuePosition * 10));
      return {
        allowed: false,
        reason: `concurrency limit reached (${current}/${maxConcurrent} in-flight)`,
        retryAfterSec,
      };
    }

    this.inflight.set(providerId, current + 1);
    return { allowed: true, reason: "acquired" };
  }

  /**
   * Release a concurrency slot after the request completes (success or error).
   * Safe to call even if no slot was acquired — decrements only if > 0.
   */
  release(providerId: number): void {
    const current = this.inflight.get(providerId) ?? 0;
    if (current > 0) {
      this.inflight.set(providerId, current - 1);
    }
  }

  /**
   * Get current in-flight count for a provider (for WebUI display).
   */
  getInflight(providerId: number): number {
    return this.inflight.get(providerId) ?? 0;
  }

  /**
   * Get in-flight counts for all providers that have a concurrency limit.
   */
  getAllInflight(): Map<number, number> {
    const result = new Map<number, number>();
    for (const [providerId] of this.limits) {
      const count = this.inflight.get(providerId) ?? 0;
      if (count > 0) result.set(providerId, count);
    }
    return result;
  }
}
