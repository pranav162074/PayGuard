import { z } from "zod";

import { KEY_MODES, ROLES } from "../models/index.js";

export const email = z.email().max(254).toLowerCase();
// Long passphrases are welcome; the upper bound stops multi-megabyte "passwords" from
// tying up the CPU in scrypt
export const password = z.string().min(12, "Use at least 12 characters").max(128);
const name = z.string().trim().min(1).max(100);
const role = z.enum(ROLES);

export const signupBody = z.strictObject({ email, password, name, businessName: name });
export const loginBody = z.strictObject({
  email,
  password: z.string().max(128),
  merchantId: z.string().optional(),
});
export const acceptInvitationBody = z.strictObject({
  token: z.string().min(1).max(100),
  password: z.string().max(128),
  // Needed only when the invitation creates a new account
  name: name.optional(),
});
export const inviteBody = z.strictObject({ email, role });
export const changeRoleBody = z.strictObject({ role });
export const createApiKeyBody = z.strictObject({ name, mode: z.enum(KEY_MODES) });
