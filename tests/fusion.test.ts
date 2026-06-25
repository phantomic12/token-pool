import { describe, it, expect } from "vitest";
import { DatabaseService } from "@/db";
import { FusionService } from "@/fusion";
import { ProviderService } from "@/providers";

describe("FusionService", () => {
  it("creates and retrieves fusion pools", () => {
    const db = new DatabaseService(":memory:");
    const svc = new FusionService(db);

    const id = svc.create("my_pool", "best_of_n", "google/gemini-2.5-flash");
    const pool = svc.get(id)!;

    expect(pool.name).toBe("my_pool");
    expect(pool.arbiterStrategy).toBe("best_of_n");
    expect(pool.arbiterModelId).toBe("google/gemini-2.5-flash");

    db.close();
  });

  it("lists all pools", () => {
    const db = new DatabaseService(":memory:");
    const svc = new FusionService(db);

    svc.create("pool_a", "best_of_n", "model-a");
    svc.create("pool_b", "synthesize", "model-b");

    const pools = svc.list();
    expect(pools.length).toBe(2);

    db.close();
  });

  it("updates pool config", () => {
    const db = new DatabaseService(":memory:");
    const svc = new FusionService(db);

    const id = svc.create("pool", "best_of_n", "model-a");
    svc.update(id, { arbiterStrategy: "majority" });

    const pool = svc.get(id)!;
    expect(pool.arbiterStrategy).toBe("majority");

    db.close();
  });

  it("deletes pool and cascades members", () => {
    const db = new DatabaseService(":memory:");
    const svc = new FusionService(db);
    const providers = new ProviderService(db);

    const providerId = providers.create({
      name: "test",
      baseUrl: "https://api.test.com",
      type: "free",
      rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null,
      enabled: true,
    });

    const poolId = svc.create("pool", "best_of_n", "model-a");
    svc.setMembers(poolId, [
      { modelId: "model-1", providerId, position: 0 },
      { modelId: "model-2", providerId, position: 1 },
    ]);

    expect(svc.listMembers(poolId).length).toBe(2);

    svc.delete(poolId);
    expect(svc.get(poolId)).toBeUndefined();
    expect(svc.listMembers(poolId).length).toBe(0);

    db.close();
  });

  it("replaces members on setMembers", () => {
    const db = new DatabaseService(":memory:");
    const svc = new FusionService(db);
    const providers = new ProviderService(db);

    const providerId = providers.create({
      name: "test",
      baseUrl: "https://api.test.com",
      type: "free",
      rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null,
      enabled: true,
    });

    const poolId = svc.create("pool", "best_of_n", "model-a");
    svc.setMembers(poolId, [
      { modelId: "old-1", providerId, position: 0 },
      { modelId: "old-2", providerId, position: 1 },
    ]);

    svc.setMembers(poolId, [
      { modelId: "new-1", providerId, position: 0 },
    ]);

    const members = svc.listMembers(poolId);
    expect(members.length).toBe(1);
    expect(members[0].modelId).toBe("new-1");

    db.close();
  });

  it("getByName finds pool by name", () => {
    const db = new DatabaseService(":memory:");
    const svc = new FusionService(db);

    svc.create("special_pool", "synthesize", "model-a");
    const pool = svc.getByName("special_pool");
    expect(pool).toBeDefined();
    expect(pool!.arbiterStrategy).toBe("synthesize");

    db.close();
  });
});
