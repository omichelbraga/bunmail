import { describe, test, expect } from "bun:test";
import {
  normalizeMailboxAddress,
  hashMailboxPassword,
  verifyMailboxPassword,
  MIN_PASSWORD_LENGTH,
} from "../../src/modules/mailboxes/services/mailbox.service.ts";

/**
 * Pure-function coverage for the mailbox service: address normalisation
 * (the Maildir-safe subset of RFC 5321) and the Dovecot-compatible
 * password hashing contract. DB-backed methods are exercised by the
 * integration tier.
 */

describe("normalizeMailboxAddress", () => {
  test("lower-cases and splits a valid address", () => {
    expect(normalizeMailboxAddress("  Mike.Smith+dev@Example.COM ")).toEqual({
      email: "mike.smith+dev@example.com",
      localPart: "mike.smith+dev",
      domainName: "example.com",
    });
  });

  test("rejects addresses without a domain or local part", () => {
    expect(normalizeMailboxAddress("mike")).toBeNull();
    expect(normalizeMailboxAddress("@example.com")).toBeNull();
    expect(normalizeMailboxAddress("mike@")).toBeNull();
  });

  test("rejects characters that are unsafe for a Maildir path", () => {
    expect(normalizeMailboxAddress("mi/ke@example.com")).toBeNull();
    expect(normalizeMailboxAddress("mi ke@example.com")).toBeNull();
    expect(normalizeMailboxAddress('"quoted"@example.com')).toBeNull();
    expect(normalizeMailboxAddress(".leading@example.com")).toBeNull();
    expect(normalizeMailboxAddress("trailing.@example.com")).toBeNull();
  });

  test("rejects an over-long local part", () => {
    expect(normalizeMailboxAddress(`${"a".repeat(65)}@example.com`)).toBeNull();
    expect(normalizeMailboxAddress(`${"a".repeat(64)}@example.com`)).not.toBeNull();
  });

  test("rejects a bare TLD or malformed domain", () => {
    expect(normalizeMailboxAddress("mike@localhost")).toBeNull();
    expect(normalizeMailboxAddress("mike@-bad.com")).toBeNull();
  });
});

describe("mailbox password hashing (Dovecot BLF-CRYPT contract)", () => {
  test("produces a {BLF-CRYPT}-prefixed bcrypt hash", async () => {
    const hash = await hashMailboxPassword("correct horse battery");
    expect(hash.startsWith("{BLF-CRYPT}$2")).toBe(true);
    /** bcrypt output is 60 chars; plus the 11-char scheme prefix. */
    expect(hash.length).toBe(71);
  });

  test("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashMailboxPassword("correct horse battery");
    expect(await verifyMailboxPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyMailboxPassword("wrong", hash)).toBe(false);
  });

  test("accepts a hash stored without the scheme prefix", async () => {
    const hash = await hashMailboxPassword("correct horse battery");
    const bare = hash.replace("{BLF-CRYPT}", "");
    expect(await verifyMailboxPassword("correct horse battery", bare)).toBe(true);
  });

  test("never throws on garbage hashes", async () => {
    expect(await verifyMailboxPassword("x", "")).toBe(false);
    expect(await verifyMailboxPassword("x", "{BLF-CRYPT}not-a-hash")).toBe(false);
    expect(await verifyMailboxPassword("x", "{SHA512-CRYPT}$6$abc")).toBe(false);
  });

  test("exposes the minimum password length used by the DTO", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
  });
});
