import { createHash } from "node:crypto";

import type { RequestHandler } from "express";

import { ApiError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Models } from "../models/index.js";
import { isDuplicateKey } from "../validation.js";
import { principalOf } from "./auth.js";

const HEADER = "idempotency-key";
// A request holding a key longer than this is assumed to have crashed; its key can be retried
const LOCK_MS = 60_000;
const VALID_KEY = /^[\x21-\x7e]{1,255}$/; // printable ASCII, no spaces

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  // JSON.stringify(undefined) returns undefined, despite its type
  return value === undefined ? "null" : JSON.stringify(value);
}

/**
 * Stripe-style idempotency for POST requests. Send the same `Idempotency-Key` again after a
 * timeout or a dropped connection and you get the first response back, instead of a second
 * payment.
 *
 * - First request with a key: stored as in progress, run, and its response saved.
 * - Same key, same request, finished: the saved response is replayed (Idempotent-Replayed: true).
 * - Same key while the first is still running: 409, try again shortly.
 * - Same key, different request: 422, a bug in the caller.
 * - A 5xx isn't saved, so retrying it runs the request again.
 *
 * Keys are scoped to the merchant and mode, and kept for 24 hours.
 */
export function idempotency(models: Models, logger: Logger): RequestHandler {
  return async (req, res, next) => {
    const key = req.get(HEADER);
    if (key === undefined || req.method !== "POST") {
      next();
      return;
    }
    if (!VALID_KEY.test(key)) {
      throw new ApiError(422, "invalid_idempotency_key", "Use 1-255 printable characters");
    }
    const principal = principalOf(req);
    const id = createHash("sha256")
      .update(
        `${principal.merchantId}|${principal.kind === "api_key" ? principal.mode : "user"}|${key}`,
      )
      .digest("hex");
    const requestHash = createHash("sha256")
      .update(`${req.method} ${req.originalUrl.split("?")[0] ?? ""} ${stableStringify(req.body)}`)
      .digest("hex");

    const now = Date.now();
    try {
      await models.IdempotencyRecord.create({
        _id: id,
        requestHash,
        state: "in_progress",
        lockedUntil: new Date(now + LOCK_MS),
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const existing = await models.IdempotencyRecord.findById(id).lean();
      if (!existing)
        throw new ApiError(409, "idempotency_in_progress", "Retry this request shortly");
      if (existing.requestHash !== requestHash) {
        throw new ApiError(
          422,
          "idempotency_key_reused",
          "This Idempotency-Key was already used with a different request",
        );
      }
      if (existing.state === "done" && existing.response?.status) {
        res.setHeader("Idempotent-Replayed", "true");
        res.status(existing.response.status).json(existing.response.body);
        return;
      }
      // Still running, unless its lock ran out (the first request crashed): then take over
      const takenOver = await models.IdempotencyRecord.findOneAndUpdate(
        { _id: id, state: "in_progress", lockedUntil: { $lt: new Date(now) } },
        { $set: { lockedUntil: new Date(now + LOCK_MS) } },
      );
      if (!takenOver) {
        res.setHeader("Retry-After", "1");
        throw new ApiError(
          409,
          "idempotency_in_progress",
          "A request with this Idempotency-Key is still being processed",
        );
      }
    }

    // Save the response before it's sent, so a retry arriving right after sees it
    const send = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      const saved =
        status >= 500
          ? models.IdempotencyRecord.deleteOne({ _id: id })
          : models.IdempotencyRecord.updateOne(
              { _id: id },
              { $set: { state: "done", response: { status, body } } },
            );
      saved
        .catch((err: unknown) => {
          logger.error({ err }, "Could not save the idempotent response");
        })
        .finally(() => {
          send(body);
        });
      return res;
    };
    next();
  };
}
