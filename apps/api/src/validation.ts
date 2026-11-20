import type { z } from "zod";

import { ApiError } from "./errors.js";

/** Parses a request body or query against a schema, or fails with a 422 naming each bad field. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new ApiError(
    422,
    "validation_error",
    "The request has invalid fields",
    result.error.issues.map((issue) => ({
      field: issue.path.join(".") || null,
      message: issue.message,
    })),
  );
}

export function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;
}

/** Which field a duplicate-key error was about, like "email". */
export function duplicateField(err: unknown): string | undefined {
  if (!isDuplicateKey(err)) return undefined;
  const pattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern ?? {};
  return Object.keys(pattern)[0];
}
