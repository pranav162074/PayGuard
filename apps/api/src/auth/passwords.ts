import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * Password hashing with scrypt (built into Node, memory-hard, recommended by OWASP).
 * Stored as "scrypt$N$r$p$salt$hash", so the cost can be raised later without breaking
 * existing hashes.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
// N=2^15, r=8 needs 32 MiB, just over Node's default limit
const MAX_MEMORY = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, KEY_LENGTH, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, { ...PARAMS, maxmem: MAX_MEMORY });
  const { N, r, p } = PARAMS;
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !N || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEMORY,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A real hash of a random password. Logging in with an unknown email still verifies against
 * this, so the response takes as long as for a real account and timing doesn't reveal which
 * emails are registered.
 */
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));
