import { describe, it, expect } from "vitest";
import { CryptoService } from "@/auth/crypto";

describe("CryptoService", () => {
  it("round-trips encryption", () => {
    const c = new CryptoService("test-secret");
    const plaintext = "sk-api-key-12345";
    const enc = c.encrypt(plaintext);
    expect(enc).not.toBe(plaintext);
    expect(c.decrypt(enc)).toBe(plaintext);
  });

  it("produces different ciphertexts for same plaintext (random IV)", () => {
    const c = new CryptoService("test-secret");
    const p = "same-key";
    expect(c.encrypt(p)).not.toBe(c.encrypt(p));
  });

  it("fails decryption with wrong secret", () => {
    const c1 = new CryptoService("secret-1");
    const c2 = new CryptoService("secret-2");
    const enc = c1.encrypt("hello");
    expect(() => c2.decrypt(enc)).toThrow();
  });
});
