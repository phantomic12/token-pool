import type { DatabaseService } from "@/db";
import type { TierName, TierModel, Provider } from "@/types";
import type { ProviderService } from "@/providers";

export interface ResolvedModel {
  modelId: string;
  provider: Provider;
  providerKeyId: number;
}

/**
 * Resolve which model+provider+key to use for a given tier.
 * Walks the tier_models table in priority order, skipping
 * providers that are disabled or have no available keys.
 */
export function resolveTierModel(
  db: DatabaseService,
  providers: ProviderService,
  tier: TierName,
): ResolvedModel | null {
  const tierRow = db.prepare("SELECT id FROM tiers WHERE name = ?").get(tier) as { id: number } | undefined;
  if (!tierRow) return null;

  const tierModels = db.prepare(
    "SELECT * FROM tier_models WHERE tier_id = ? ORDER BY priority"
  ).all(tierRow.id) as TierModel[];

  for (const tm of tierModels) {
    const provider = providers.get(tm.providerId);
    if (!provider || !provider.enabled) continue;

    // Round-robin: pick the next enabled key
    const key = providers.listKeys(tm.providerId).find(k => k.enabled);
    if (!key) continue;

    return {
      modelId: tm.modelId,
      provider,
      providerKeyId: key.id,
    };
  }

  return null;
}

/**
 * Get the fallback chain for a tier — all model candidates in priority order.
 */
export function getFallbackChain(
  db: DatabaseService,
  providers: ProviderService,
  tier: TierName,
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

    const key = providers.listKeys(tm.providerId).find(k => k.enabled);
    if (!key) continue;

    chain.push({
      modelId: tm.modelId,
      provider,
      providerKeyId: key.id,
    });
  }

  return chain;
}
