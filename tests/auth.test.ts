import { describe, it, expect } from "vitest";
import { DatabaseService } from "@/db";
import { UserService } from "@/auth/user-service";

describe("UserService", () => {
  it("creates and retrieves users", () => {
    const db = new DatabaseService(":memory:");
    const svc = new UserService(db);

    const id = svc.create("alice", "password123", "admin");
    const user = svc.getById(id)!;

    expect(user.username).toBe("alice");
    expect(user.role).toBe("admin");
    expect(user.passwordHash).not.toBe("password123"); // should be hashed

    db.close();
  });

  it("verifies correct password", () => {
    const db = new DatabaseService(":memory:");
    const svc = new UserService(db);

    svc.create("bob", "secret", "regular");
    const user = svc.verifyPassword("bob", "secret");
    expect(user).not.toBeNull();
    expect(user!.username).toBe("bob");

    db.close();
  });

  it("rejects wrong password", () => {
    const db = new DatabaseService(":memory:");
    const svc = new UserService(db);

    svc.create("bob", "secret", "regular");
    const user = svc.verifyPassword("bob", "wrong");
    expect(user).toBeNull();

    db.close();
  });

  it("rejects non-existent user", () => {
    const db = new DatabaseService(":memory:");
    const svc = new UserService(db);

    const user = svc.verifyPassword("nobody", "password");
    expect(user).toBeNull();

    db.close();
  });

  it("bootstraps admin on first run", () => {
    const db = new DatabaseService(":memory:");
    const svc = new UserService(db);

    expect(svc.count()).toBe(0);

    const result = svc.bootstrapAdmin();
    expect(result).not.toBeNull();
    expect(result!.username).toBe("admin");
    expect(result!.password.length).toBe(24);

    // Admin should be created
    expect(svc.count()).toBe(1);
    const admin = svc.getByUsername("admin")!;
    expect(admin.role).toBe("admin");

    // Password should work
    const verified = svc.verifyPassword("admin", result!.password);
    expect(verified).not.toBeNull();

    db.close();
  });

  it("does not bootstrap if users already exist", () => {
    const db = new DatabaseService(":memory:");
    const svc = new UserService(db);

    svc.create("existing", "user", "regular");
    const result = svc.bootstrapAdmin();
    expect(result).toBeNull();
    expect(svc.count()).toBe(1);

    db.close();
  });

  it("bootstraps with password override", () => {
    const db = new DatabaseService(":memory:");
    const svc = new UserService(db);

    const result = svc.bootstrapAdmin("my-custom-password");
    expect(result!.password).toBe("my-custom-password");

    const verified = svc.verifyPassword("admin", "my-custom-password");
    expect(verified).not.toBeNull();

    db.close();
  });

  it("updates user role", () => {
    const db = new DatabaseService(":memory:");
    const svc = new UserService(db);

    const id = svc.create("user1", "pass", "regular");
    svc.updateRole(id, "admin");
    expect(svc.getById(id)!.role).toBe("admin");

    db.close();
  });

  it("deletes user", () => {
    const db = new DatabaseService(":memory:");
    const svc = new UserService(db);

    const id = svc.create("temp", "pass", "regular");
    expect(svc.delete(id)).toBe(true);
    expect(svc.getById(id)).toBeUndefined();

    db.close();
  });

  it("lists users without password hashes", () => {
    const db = new DatabaseService(":memory:");
    const svc = new UserService(db);

    svc.create("alice", "pass1", "admin");
    svc.create("bob", "pass2", "regular");

    const users = svc.list();
    expect(users.length).toBe(2);
    expect(users[0].username).toBe("alice");
    expect((users[0] as any).passwordHash).toBeUndefined();

    db.close();
  });
});
