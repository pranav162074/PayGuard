import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../src/auth/passwords.js";

describe("passwords", () => {
  it("verifies the right password and rejects others", async () => {
    const hash = await hashPassword("correct horse battery");

    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse battery!", hash)).toBe(false);
  });

  it("salts every hash, and records the cost so it can be raised later", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);

    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
  });

  it("treats the same text typed differently as the same password", async () => {
    // "é" as one character vs "e" plus a combining accent
    const hash = await hashPassword("café au lait 1234");

    expect(await verifyPassword("café au lait 1234", hash)).toBe(true);
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    expect(await verifyPassword("anything", "md5$abc")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });
});
