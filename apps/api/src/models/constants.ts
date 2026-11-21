export const ROLES = ["owner", "developer", "analyst"] as const;
export type Role = (typeof ROLES)[number];

export const KEY_MODES = ["test", "live"] as const;
export type KeyMode = (typeof KEY_MODES)[number];
