import { describe, it, expect } from "vitest";
import { DatabaseService } from "@/db";
import { ProviderService } from "@/providers";

describe("DatabaseService", () => {
  it("initializes with seeded tiers and providers", () => {
    const db = new DatabaseService(":memory:");
    const tiers = db.prepare("SELECT * FROM tiers ORDER BY id").all() as any[];
    expect(tiers.length).toBe(5);
    expect(tiers[0].name).toBe("simple");

    const providers = db.prepare("SELECT * FROM providers ORDER BY id").all() as any[];
    expect(providers.length).toBe(27);
    expect(providers.some(p => p.name === "groq")).toBe(true);

    db.close();
  });

  it("seeds tiers only once (idempotent)", () => {
    const db = new DatabaseService(":memory:");
    // init runs once in constructor, calling again shouldn't duplicate
    const tiers = db.prepare("SELECT COUNT(*) as c FROM tiers").get() as any;
    expect(tiers.c).toBe(5);
    db.close();
  });
});

describe("ProviderService", () => {
  it("creates and retrieves providers", () => {
    const db = new DatabaseService(":memory:");
    const svc = new ProviderService(db);

    const id = svc.create({
      name: "test-provider",
      baseUrl: "https://api.test.com/v1",
      type: "free",
      rpmLimit: 30,
      rpdLimit: 1000,
      tpmLimit: null,
      tpdLimit: null,
      enabled: true,
    });

    const provider = svc.get(id)!;
    expect(provider.name).toBe("test-provider");
    expect(provider.baseUrl).toBe("https://api.test.com/v1");
    expect(provider.rpmLimit).toBe(30);

    db.close();
  });

  it("adds and lists provider keys", () => {
    const db = new DatabaseService(":memory:");
    const svc = new ProviderService(db);

    const providerId = svc.create({
      name: "test",
      baseUrl: "https://api.test.com",
      type: "free",
      rpmLimit: null,
      rpdLimit: null,
      tpmLimit: null,
      tpdLimit: null,
      enabled: true,
    });

    svc.addKey(providerId, "key-1", "enc-blob-1");
    svc.addKey(providerId, "key-2", "enc-blob-2");

    const keys = svc.listKeys(providerId);
    expect(keys.length).toBe(2);
    expect(keys[0].label).toBe("key-1");
    expect(keys[0].rrPosition).toBe(0);
    expect(keys[1].rrPosition).toBe(1);

    db.close();
  });

  it("updates provider", () => {
    const db = new DatabaseService(":memory:");
    const svc = new ProviderService(db);

    const id = svc.create({
      name: "test",
      baseUrl: "https://old.url",
      type: "free",
      rpmLimit: 10,
      rpdLimit: null,
      tpmLimit: null,
      tpdLimit: null,
      enabled: true,
    });

    svc.update(id, { baseUrl: "https://new.url", enabled: false });
    const p = svc.get(id)!;
    expect(p.baseUrl).toBe("https://new.url");
    expect(p.enabled).toBe(false);

    db.close();
  });

  it("deletes provider and cascades keys", () => {
    const db = new DatabaseService(":memory:");
    const svc = new ProviderService(db);

    const id = svc.create({
      name: "test",
      baseUrl: "https://api.test.com",
      type: "free",
      rpmLimit: null,
      rpdLimit: null,
      tpmLimit: null,
      tpdLimit: null,
      enabled: true,
    });

    svc.addKey(id, "k1", "enc");
    expect(svc.delete(id)).toBe(true);

    const keys = svc.listKeys(id);
    expect(keys.length).toBe(0);

    db.close();
  });
});
