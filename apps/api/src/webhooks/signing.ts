/**
 * Webhook signatures, the scheme Stripe uses:
 *
 *     PayGuard-Signature: t=1764230400,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
 *
 * v1 is the hex HMAC-SHA256 of `${t}.${raw body}` with the endpoint's secret. The timestamp is
 * signed, so a receiver can refuse old requests (replays). During a secret rotation there is
 * one v1 per active secret; a receiver accepts the request if any of them matches.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const SIGNATURE_HEADER = "PayGuard-Signature";
/** Receivers should refuse signatures older than this (our verifier's default). */
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export function generateSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signatureHeader(secrets: string[], timestamp: number, body: string): string {
  return [`t=${timestamp}`, ...secrets.map((secret) => `v1=${sign(secret, timestamp, body)}`)].join(
    ",",
  );
}

export class SignatureError extends Error {
  override name = "SignatureError";
}

/**
 * What a merchant's server does with a delivery (exported so tests, and the docs, use the same
 * code). `body` must be the raw request body, before any JSON parsing.
 */
export function verifySignature(
  header: string | undefined,
  body: string,
  secret: string,
  { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = Date.now() } = {},
): { timestamp: number } {
  if (!header) throw new SignatureError("No signature header");
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) {
    throw new SignatureError("Malformed signature header");
  }
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) {
    throw new SignatureError("Signature timestamp outside the tolerance");
  }
  const expected = Buffer.from(sign(secret, timestamp, body), "hex");
  const ok = signatures.some((candidate) => {
    const given = Buffer.from(candidate, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new SignatureError("No signature matches");
  return { timestamp };
}

/** AES-256-GCM for secrets at rest: "v1.<iv>.<tag>.<ciphertext>", base64url parts. */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyBase64url: string) {
    this.key = Buffer.from(keyBase64url, "base64url");
    if (this.key.length !== 32) throw new Error("The secrets key must be 32 bytes");
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), ciphertext]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
  }

  decrypt(encrypted: string): string {
    const [version, iv, tag, ciphertext] = encrypted.split(".");
    if (version !== "v1" || !iv || !tag || ciphertext === undefined) {
      throw new Error("Unrecognised encrypted secret");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}
