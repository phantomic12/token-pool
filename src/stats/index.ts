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
              COALESCE(SUM(cost_usd), 0) as totalCost,
              SUM(CASE WHEN output_tokens = 0 THEN 1 ELSE 0 END) as errorCount
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

    const byModel = this.db.prepare(
      `SELECT model_id as modelId,
              COUNT(*) as count,
              SUM(input_tokens) as inputTokens,
              SUM(output_tokens) as outputTokens,
              AVG(latency_ms) as avgLatencyMs
       FROM usage_events WHERE timestamp >= ?
       GROUP BY model_id ORDER BY count DESC`
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

    return { total, byProvider, byTier, byUser, byModel, daily, fusionStats };
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

  /**
   * Get individual request logs (paginated).
   */
  getLogs(limit: number = 50, offset: number = 0, providerId?: number) {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const params: any[] = [since];
    let filter = "";
    if (providerId) {
      filter = " AND provider_id = ?";
      params.push(providerId);
    }
    const rows = this.db.prepare(
      `SELECT id, user_id as userId, provider_id as providerId, model_id as modelId, tier,
              input_tokens as inputTokens, output_tokens as outputTokens, latency_ms as latencyMs,
              cost_usd as costUsd, timestamp
       FROM usage_events WHERE timestamp >= ?${filter}
       ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as total FROM usage_events WHERE timestamp >= ?${filter}`
    ).get(...params) as { total: number };

    return { logs: rows, total: countRow.total };
  }

  /**
   * Get budget for a provider.
   */
  getBudget(providerId: number): { dailyLimitUsd: number | null; monthlyLimitUsd: number | null; alertThresholdPct: number } | null {
    const row = this.db.prepare("SELECT * FROM budgets WHERE provider_id = ?").get(providerId) as any;
    if (!row) return null;
    return {
      dailyLimitUsd: row.daily_limit_usd,
      monthlyLimitUsd: row.monthly_limit_usd,
      alertThresholdPct: row.alert_threshold_pct ?? 80,
    };
  }

  /**
   * Set budget for a provider.
   */
  setBudget(providerId: number, dailyLimitUsd: number | null, monthlyLimitUsd: number | null, alertThresholdPct: number = 80): void {
    this.db.prepare(
      `INSERT INTO budgets (provider_id, daily_limit_usd, monthly_limit_usd, alert_threshold_pct)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         daily_limit_usd = ?, monthly_limit_usd = ?, alert_threshold_pct = ?`
    ).run(providerId, dailyLimitUsd, monthlyLimitUsd, alertThresholdPct, dailyLimitUsd, monthlyLimitUsd, alertThresholdPct);
  }

  deleteBudget(providerId: number): void {
    this.db.prepare("DELETE FROM budgets WHERE provider_id = ?").run(providerId);
  }

  /**
   * Get spend for a provider today and this month.
   */
  getProviderSpend(providerId: number): { dailySpend: number; monthlySpend: number } {
    const dayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

    const daily = this.db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as spend FROM usage_events WHERE provider_id = ? AND timestamp >= ?"
    ).get(providerId, dayStart) as { spend: number };

    const monthly = this.db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as spend FROM usage_events WHERE provider_id = ? AND timestamp >= ?"
    ).get(providerId, monthStart) as { spend: number };

    return { dailySpend: daily.spend, monthlySpend: monthly.spend };
  }

  /**
   * Check if provider has exceeded budget. Returns { exceeded, reason }.
   */
  checkBudget(providerId: number): { exceeded: boolean; reason?: string; dailySpend?: number | null; dailyLimit?: number | null; monthlySpend?: number | null; monthlyLimit?: number | null } {
    const budget = this.getBudget(providerId);
    if (!budget) return { exceeded: false };

    const spend = this.getProviderSpend(providerId);

    if (budget.dailyLimitUsd != null && spend.dailySpend >= budget.dailyLimitUsd) {
      return { exceeded: true, reason: `Daily budget exceeded ($${spend.dailySpend.toFixed(2)} / $${budget.dailyLimitUsd.toFixed(2)})`, dailySpend: spend.dailySpend, dailyLimit: budget.dailyLimitUsd, monthlySpend: spend.monthlySpend, monthlyLimit: budget.monthlyLimitUsd } as any;
    }
    if (budget.monthlyLimitUsd != null && spend.monthlySpend >= budget.monthlyLimitUsd) {
      return { exceeded: true, reason: `Monthly budget exceeded ($${spend.monthlySpend.toFixed(2)} / $${budget.monthlyLimitUsd.toFixed(2)})`, dailySpend: spend.dailySpend, dailyLimit: budget.dailyLimitUsd, monthlySpend: spend.monthlySpend, monthlyLimit: budget.monthlyLimitUsd } as any;
    }

    return { exceeded: false, dailySpend: spend.dailySpend, dailyLimit: budget.dailyLimitUsd, monthlySpend: spend.monthlySpend, monthlyLimit: budget.monthlyLimitUsd };
  }

  /**
   * Get all budgets with spend for dashboard.
   */
  getAllBudgets(): Array<{ providerId: number; dailyLimitUsd: number | null; monthlyLimitUsd: number | null; alertThresholdPct: number; dailySpend: number; monthlySpend: number }> {
    const budgets = this.db.prepare("SELECT * FROM budgets").all() as any[];
    return budgets.map((b: any) => {
      const spend = this.getProviderSpend(b.provider_id);
      return {
        providerId: b.provider_id,
        dailyLimitUsd: b.daily_limit_usd,
        monthlyLimitUsd: b.monthly_limit_usd,
        alertThresholdPct: b.alert_threshold_pct ?? 80,
        dailySpend: spend.dailySpend,
        monthlySpend: spend.monthlySpend,
      };
    });
  }
}
