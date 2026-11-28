import type { Role } from "../models/index.js";

export const PERMISSIONS = [
  "team:read",
  "team:manage",
  "api_keys:read",
  "api_keys:manage",
  "payments:read",
  "payments:write",
  "risk:review",
  "webhooks:read",
  "webhooks:manage",
  "reconciliation:read",
  "reconciliation:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  developer: new Set([
    "team:read",
    "api_keys:read",
    "api_keys:manage",
    "payments:read",
    "payments:write",
    "webhooks:read",
    "webhooks:manage",
    "reconciliation:read",
    "reconciliation:manage",
  ]),
  analyst: new Set([
    "team:read",
    "payments:read",
    "risk:review",
    "webhooks:read",
    "reconciliation:read",
  ]),
};

/** Server-to-server API keys can use the payments API, but never manage the account. */
export const API_KEY_PERMISSIONS: ReadonlySet<Permission> = new Set([
  "payments:read",
  "payments:write",
]);
