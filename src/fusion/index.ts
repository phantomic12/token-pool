import type { DatabaseService } from "@/db";
import type { FusionPool, FusionPoolMember, ArbiterStrategy } from "@/types";

interface FusionPoolRow {
  id: number;
  name: string;
  arbiter_strategy: string;
  arbiter_model_id: string;
}

interface MemberRow {
  pool_id: number;
  model_id: string;
  provider_id: number;
  position: number;
}

function mapPool(r: FusionPoolRow): FusionPool {
  return {
    id: r.id,
    name: r.name,
    arbiterStrategy: r.arbiter_strategy as ArbiterStrategy,
    arbiterModelId: r.arbiter_model_id,
  };
}

function mapMember(r: MemberRow): FusionPoolMember {
  return {
    poolId: r.pool_id,
    modelId: r.model_id,
    providerId: r.provider_id,
    position: r.position,
  };
}

export class FusionService {
  constructor(private db: DatabaseService) {}

  list(): FusionPool[] {
    return (this.db.prepare("SELECT * FROM fusion_pools ORDER BY id").all() as FusionPoolRow[]).map(mapPool);
  }

  get(id: number): FusionPool | undefined {
    const r = this.db.prepare("SELECT * FROM fusion_pools WHERE id = ?").get(id) as FusionPoolRow | undefined;
    return r ? mapPool(r) : undefined;
  }

  getByName(name: string): FusionPool | undefined {
    const r = this.db.prepare("SELECT * FROM fusion_pools WHERE name = ?").get(name) as FusionPoolRow | undefined;
    return r ? mapPool(r) : undefined;
  }

  create(name: string, arbiterStrategy: ArbiterStrategy, arbiterModelId: string): number {
    const result = this.db.prepare(
      "INSERT INTO fusion_pools (name, arbiter_strategy, arbiter_model_id) VALUES (?, ?, ?)"
    ).run(name, arbiterStrategy, arbiterModelId);
    return Number(result.lastInsertRowid);
  }

  update(id: number, pool: Partial<FusionPool>): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    const merged = { ...existing, ...pool };
    this.db.prepare(
      "UPDATE fusion_pools SET name=?, arbiter_strategy=?, arbiter_model_id=? WHERE id=?"
    ).run(merged.name, merged.arbiterStrategy, merged.arbiterModelId, id);
    return true;
  }

  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM fusion_pools WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ── Members ──

  listMembers(poolId: number): FusionPoolMember[] {
    return (this.db.prepare("SELECT * FROM fusion_pool_members WHERE pool_id = ? ORDER BY position").all(poolId) as MemberRow[]).map(mapMember);
  }

  setMembers(poolId: number, members: Array<{ modelId: string; providerId: number; position: number }>): void {
    this.db.prepare("DELETE FROM fusion_pool_members WHERE pool_id = ?").run(poolId);
    const stmt = this.db.prepare(
      "INSERT INTO fusion_pool_members (pool_id, model_id, provider_id, position) VALUES (?, ?, ?, ?)"
    );
    for (const m of members) {
      stmt.run(poolId, m.modelId, m.providerId, m.position);
    }
  }
}
