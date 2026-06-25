import type { DatabaseService } from "@/db";
import type { ProviderService } from "@/providers";
import type { RateLimitGuard } from "@/providers/rate-limiter";
import type { TierName, TierModel, Provider, ProviderKey } from "@/types";

export interface ResolvedModel {
  modelId: string;
  provider: Provider;
  key: ProviderKey;
}

/**
 * Resolve which model+provider+key to use for a given tier.
 * Walks tier_models in priority order. For each candidate:
 *   - Skip if provider disabled
 *   - Use RateLimitGuard to check if any key has available quota
 * Returns first available, or null if none.
 */
export function resolveTierModel(
  db: DatabaseService,
  providers: ProviderService,
  guard: RateLimitGuard,
  tier: TierName,
  estTokens: number,
): ResolvedModel | null {
  const chain = getFallbackChain(db, providers, guard, tier, estTokens);
  return chain.length > 0 ? chain[0] : null;
}

/**
 * Get the full fallback chain for a tier — all model candidates in priority order,
 * filtered to only those with at least one available key.
 */
export function getFallbackChain(
  db: DatabaseService,
  providers: ProviderService,
  guard: RateLimitGuard,
  tier: TierName,
  estTokens: number,
): ResolvedModel[] {
  const tierRow = db.prepare("SELECT id FROM tiers WHERE name = ?").get(tier) as { id: number } | undefined;
  if (!tierRow) return [];

  const tierModels = db.prepare(
    "SELECT * FROM tier_models WHERE tier_id = ? ORDER BY priority"
  ).all(tierRow.id) as TierModel[];

  const chain: ResolvedModel[] = [];

  for (const tm of tierModels) {
    const provider = providers.get(tm.providerId);
    if (!provider || !provider.enabled) continue;

    const decision = guard.tryAcquire(provider, estTokens);
    if (decision.allowed && decision.key) {
      chain.push({
        modelId: tm.modelId,
        provider,
        key: decision.key,
      });
    }
  }

  return chain;
}
