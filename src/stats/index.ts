import type { DatabaseService } from "@/db";
import type { TierName } from "@/types";

export interface UsageRecord {
  userId: number;
  providerId: number | null;
  modelId: string;
  tier: TierName | "fusion";
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  fusionPoolId?: number | null;
  costUsd?: number | null;
}

export class UsageTracker {
  constructor(private db: DatabaseService) {}

  record(rec: UsageRecord): void {
    this.db.prepare(
      `INSERT INTO usage_events (user_id, provider_id, model_id, tier, input_tokens, output_tokens, latency_ms, fusion_pool_id, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rec.userId,
      rec.providerId,
      rec.modelId,
      rec.tier,
      rec.inputTokens,
      rec.outputTokens,
      rec.latencyMs,
      rec.fusionPoolId ?? null,
      rec.costUsd ?? null,
    );
  }

  /**
   * Get aggregated stats for dashboard.
   */
  getSummary(daysBack: number = 30) {
    const since = new Date(Date.now() - daysBack * 86400000).toISOString();

    const total = this.db.prepare(
      `SELECT COUNT(*) as count,
              COALESCE(SUM(input_tokens), 0) as inputTokens,
              COALESCE(SUM(output_tokens), 0) as outputTokens,
              COALESCE(SUM(cost_usd), 0) as totalCost
       FROM usage_events WHERE timestamp >= ?`
    ).get(since);

    const byProvider = this.db.prepare(
      `SELECT provider_id as providerId,
              COUNT(*) as count,
              SUM(input_tokens) as inputTokens,
              SUM(output_tokens) as outputTokens,
              COALESCE(SUM(cost_usd), 0) as totalCost
       FROM usage_events WHERE timestamp >= ?
       GROUP BY provider_id ORDER BY count DESC`
    ).all(since);

    const byTier = this.db.prepare(
      `SELECT tier,
              COUNT(*) as count,
              SUM(input_tokens) as inputTokens,
              SUM(output_tokens) as outputTokens
       FROM usage_events WHERE timestamp >= ?
       GROUP BY tier ORDER BY count DESC`
    ).all(since);

    const byUser = this.db.prepare(
      `SELECT user_id as userId,
              COUNT(*) as count,
              SUM(input_tokens) as inputTokens,
              SUM(output_tokens) as outputTokens
       FROM usage_events WHERE timestamp >= ?
       GROUP BY user_id ORDER BY count DESC`
    ).all(since);

    // Daily series for charts
    const daily = this.db.prepare(
      `SELECT DATE(timestamp) as date,
              COUNT(*) as count,
              SUM(input_tokens) as inputTokens,
              SUM(output_tokens) as outputTokens
       FROM usage_events WHERE timestamp >= ?
       GROUP BY DATE(timestamp) ORDER BY date`
    ).all(since);

    // Fusion-specific
    const fusionStats = this.db.prepare(
      `SELECT COUNT(*) as count,
              COALESCE(SUM(input_tokens), 0) as inputTokens,
              COALESCE(SUM(output_tokens), 0) as outputTokens,
              COALESCE(SUM(cost_usd), 0) as totalCost
       FROM usage_events WHERE tier = 'fusion' AND timestamp >= ?`
    ).get(since);

    return { total, byProvider, byTier, byUser, daily, fusionStats };
  }

  /**
   * Export usage events as CSV-ready rows.
   */
  exportCsv(daysBack: number = 30): string {
    const since = new Date(Date.now() - daysBack * 86400000).toISOString();
    const rows = this.db.prepare(
      `SELECT user_id, provider_id, model_id, tier, input_tokens, output_tokens, latency_ms, cost_usd, timestamp
       FROM usage_events WHERE timestamp >= ? ORDER BY timestamp`
    ).all(since) as any[];

    const header = "user_id,provider_id,model_id,tier,input_tokens,output_tokens,latency_ms,cost_usd,timestamp\n";
    const lines = rows.map(r =>
      `${r.user_id},${r.provider_id ?? ""},${r.model_id},${r.tier},${r.input_tokens},${r.output_tokens},${r.latency_ms},${r.cost_usd ?? ""},${r.timestamp}`
    ).join("\n");

    return header + lines;
  }
}
