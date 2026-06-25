import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseService } from "@/db";
import { ProviderService } from "@/providers";
import { RateLimitGuard } from "@/providers/rate-limiter";

function setup(providerRpm: number | null = 5, keyRpmOverride?: number | null) {
  const db = new DatabaseService(":memory:");
  const providers = new ProviderService(db);
  const guard = new RateLimitGuard(db, providers);

  const providerId = providers.create({
    name: "test-provider",
    baseUrl: "https://api.test.com/v1",
    type: "free",
    rpmLimit: providerRpm,
    rpdLimit: null,
    tpmLimit: null,
    tpdLimit: null,
    enabled: true,
  });

  const keyId = providers.addKey(providerId, "key-1", "enc-blob", keyRpmOverride !== undefined ? { rpmLimit: keyRpmOverride } : undefined);

  return { db, providers, guard, providerId, keyId };
}

describe("RateLimitGuard", () => {
  it("allows requests under RPM limit", () => {
    const { guard, providers, providerId } = setup(5);
    const provider = providers.get(providerId)!;

    const d1 = guard.tryAcquire(provider, 100);
    expect(d1.allowed).toBe(true);
    expect(d1.key).not.toBeNull();

    const d2 = guard.tryAcquire(provider, 100);
    expect(d2.allowed).toBe(true);
  });

  it("blocks when RPM limit exhausted", () => {
    const { guard, providers, providerId } = setup(2);
    const provider = providers.get(providerId)!;

    // Use up 2 RPM
    guard.tryAcquire(provider, 10);
    guard.tryAcquire(provider, 10);

    // 3rd should be blocked
    const d3 = guard.tryAcquire(provider, 10);
    expect(d3.allowed).toBe(false);
    expect(d3.reason).toContain("exhausted");
  });

  it("per-key RPM override takes precedence over provider default", () => {
    const { guard, providers, providerId } = setup(100, 1);
    const provider = providers.get(providerId)!;

    // Override says 1 RPM
    guard.tryAcquire(provider, 10);
    const d2 = guard.tryAcquire(provider, 10);
    expect(d2.allowed).toBe(false);
  });

  it("skips backed-off keys and returns all-exhausted", () => {
    const { guard, providers, providerId } = setup(10);
    const provider = providers.get(providerId)!;

    // Back off the only key
    const d1 = guard.tryAcquire(provider, 10);
    expect(d1.allowed).toBe(true);
    guard.markBackoff(d1.key!.id, 60);

    // Should be blocked — key is in backoff
    const d2 = guard.tryAcquire(provider, 10);
    expect(d2.allowed).toBe(false);
    expect(d2.reason).toContain("backoff");
    expect(d2.retryAfterSec).toBeGreaterThan(0);
  });

  it("clears backoff on clearBackoff", () => {
    const { guard, providers, providerId } = setup(10);
    const provider = providers.get(providerId)!;

    const d1 = guard.tryAcquire(provider, 10);
    guard.markBackoff(d1.key!.id, 60);

    // Blocked
    expect(guard.tryAcquire(provider, 10).allowed).toBe(false);

    // Clear
    guard.clearBackoff(d1.key!.id);

    // Should work again
    const d3 = guard.tryAcquire(provider, 10);
    expect(d3.allowed).toBe(true);
  });

  it("round-robins to second key when first is exhausted", () => {
    const { db, guard, providers, providerId } = setup(1);
    const provider = providers.get(providerId)!;

    // Add a second key
    const key2Id = providers.addKey(providerId, "key-2", "enc-blob-2");

    // First request uses key-1 (RPM=1)
    const d1 = guard.tryAcquire(provider, 10);
    expect(d1.allowed).toBe(true);
    expect(d1.key!.label).toBe("key-1");

    // Second request: key-1 exhausted, should use key-2
    const d2 = guard.tryAcquire(provider, 10);
    expect(d2.allowed).toBe(true);
    expect(d2.key!.label).toBe("key-2");

    // Third request: both exhausted
    const d3 = guard.tryAcquire(provider, 10);
    expect(d3.allowed).toBe(false);

    db.close();
  });

  it("tracks TPM across requests in same minute window", () => {
    const { db, guard, providers, providerId } = setup(null); // no RPM limit

    // Update provider to have TPM=1000, then re-fetch
    providers.update(providerId, { tpmLimit: 1000 });
    const provider = providers.get(providerId)!;

    const d1 = guard.tryAcquire(provider, 600);
    expect(d1.allowed).toBe(true);

    // 600 + 500 = 1100 > 1000
    const d2 = guard.tryAcquire(provider, 500);
    expect(d2.allowed).toBe(false);
    expect(d2.reason).toContain("exhausted");

    db.close();
  });

  it("returns quota usage for WebUI", () => {
    const { guard, providers, providerId } = setup(10);
    const provider = providers.get(providerId)!;

    guard.tryAcquire(provider, 500);

    const usage = guard.getProviderKeyUsage(provider);
    expect(usage.length).toBe(1);
    expect(usage[0].usage.rpmUsed).toBe(1);
    expect(usage[0].usage.tpmUsed).toBe(500);
    expect(usage[0].usage.rpmLimit).toBe(10);
    expect(usage[0].inBackoff).toBe(false);
  });
});
