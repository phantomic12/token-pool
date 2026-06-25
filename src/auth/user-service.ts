import bcrypt from "bcryptjs";
import type { DatabaseService } from "@/db";
import type { User, AuthUser } from "@/types";

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
}

function mapUser(r: UserRow): AuthUser {
  return {
    id: r.id,
    username: r.username,
    passwordHash: r.password_hash,
    role: r.role as "admin" | "regular",
    createdAt: r.created_at,
  };
}

export class UserService {
  constructor(private db: DatabaseService) {}

  create(username: string, password: string, role: "admin" | "regular" = "regular"): number {
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    const result = this.db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)"
    ).run(username, passwordHash, role);
    return Number(result.lastInsertRowid);
  }

  getById(id: number): AuthUser | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return r ? mapUser(r) : undefined;
  }

  getByUsername(username: string): AuthUser | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
    return r ? mapUser(r) : undefined;
  }

  list(): User[] {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY id").all() as UserRow[];
    return rows.map(r => ({
      id: r.id,
      username: r.username,
      role: r.role as "admin" | "regular",
      createdAt: r.created_at,
    }));
  }

  verifyPassword(username: string, password: string): AuthUser | null {
    const user = this.getByUsername(username);
    if (!user) return null;
    if (!bcrypt.compareSync(password, user.passwordHash)) return null;
    return user;
  }

  updateRole(id: number, role: "admin" | "regular"): boolean {
    const result = this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
    return result.changes > 0;
  }

  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return result.changes > 0;
  }

  count(): number {
    const r = this.db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
    return r.c;
  }

  /**
   * Bootstrap admin on first run: if no users exist, create admin with random password.
   * Returns the plaintext password (only shown once) or null if not needed.
   */
  bootstrapAdmin(passwordOverride?: string): { username: string; password: string } | null {
    if (this.count() > 0) return null;

    const password = passwordOverride ?? generatePassword();
    this.create("admin", password, "admin");
    return { username: "admin", password };
  }
}

function generatePassword(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let pw = "";
  for (let i = 0; i < 24; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}
