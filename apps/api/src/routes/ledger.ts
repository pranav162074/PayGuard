import { Router, type Request } from "express";
import { Types } from "mongoose";
import { z } from "zod";

import { ApiError } from "../errors.js";
import { CHART } from "../ledger/chart.js";
import type { LedgerAccount, LedgerPosting } from "../ledger/models.js";
import { ensureAccounts, verifyLedger } from "../ledger/service.js";
import { authenticate, objectIdParam, principalOf, requirePermission } from "../middleware/auth.js";
import { KEY_MODES, type KeyMode } from "../models/index.js";
import { parse } from "../validation.js";
import type { RouteDeps } from "./deps.js";

/** API keys see their own mode's books; dashboard users pick one with ?mode= (test by default). */
function modeOf(req: Request): KeyMode {
  const principal = principalOf(req);
  if (principal.kind === "api_key") return principal.mode;
  return parse(z.object({ mode: z.enum(KEY_MODES).default("test") }), req.query).mode;
}

function accountJson(account: LedgerAccount) {
  return {
    id: account._id.toString(),
    code: account.code,
    name: account.name,
    type: account.type,
    currency: account.currency,
    balance: account.balance,
    totalDebits: account.debits,
    totalCredits: account.credits,
  };
}

const statementQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

function encodeCursor(posting: LedgerPosting): string {
  return Buffer.from(`${posting.postedAt.toISOString()}|${posting._id.toString()}`).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { postedAt: Date; id: Types.ObjectId } {
  const [postedAt, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const date = new Date(postedAt ?? "");
  if (!id || !Types.ObjectId.isValid(id) || Number.isNaN(date.getTime())) {
    throw new ApiError(422, "invalid_cursor", "The cursor is not valid");
  }
  return { postedAt: date, id: new Types.ObjectId(id) };
}

export function ledgerRouter(deps: RouteDeps): Router {
  const { models } = deps;
  const router = Router();
  router.use("/v1/ledger", authenticate(deps), requirePermission("payments:read"));

  /** The merchant's accounts and balances (in minor units: paise). */
  router.get("/v1/ledger/accounts", async (req, res) => {
    const merchantId = new Types.ObjectId(principalOf(req).merchantId);
    const mode = modeOf(req);
    const accounts = await ensureAccounts(models, merchantId, mode, "INR");
    res.json({
      mode,
      accounts: CHART.map((spec) => accountJson(accounts.get(spec.code) as LedgerAccount)),
    });
  });

  /** An account's statement: every posting, newest first, with the running balance. */
  router.get("/v1/ledger/accounts/:code/postings", async (req, res) => {
    const merchantId = principalOf(req).merchantId;
    const mode = modeOf(req);
    const { limit, cursor } = parse(statementQuery, req.query);
    const account = await models.LedgerAccount.findOne({
      merchantId,
      mode,
      code: req.params.code,
    }).lean();
    if (!account) throw new ApiError(404, "not_found", "Account not found");

    const filter: Record<string, unknown> = { accountId: account._id };
    if (cursor) {
      const after = decodeCursor(cursor);
      filter.$or = [
        { postedAt: { $lt: after.postedAt } },
        { postedAt: after.postedAt, _id: { $lt: after.id } },
      ];
    }
    const rows = await models.LedgerPosting.find(filter)
      .sort({ postedAt: -1, _id: -1 })
      .limit(limit + 1)
      .populate<{ entryId: { _id: Types.ObjectId; description: string } }>("entryId", "description")
      .lean();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.json({
      account: accountJson(account),
      postings: page.map((p) => ({
        id: p._id.toString(),
        entryId: p.entryId._id.toString(),
        description: p.entryId.description,
        direction: p.direction,
        amount: p.amount,
        balanceAfter: p.balanceAfter,
        postedAt: p.postedAt,
      })),
      nextCursor:
        rows.length > limit && last ? encodeCursor({ ...last, entryId: last.entryId._id }) : null,
    });
  });

  router.get("/v1/ledger/entries/:id", async (req, res) => {
    const id = objectIdParam(req.params.id, "Ledger entry");
    const entry = await models.LedgerEntry.findOne({
      _id: id,
      merchantId: principalOf(req).merchantId,
      mode: modeOf(req),
    }).lean();
    if (!entry) throw new ApiError(404, "not_found", "Ledger entry not found");
    res.json({
      id: entry._id.toString(),
      description: entry.description,
      currency: entry.currency,
      lines: entry.lines.map((l) => ({
        account: l.accountCode,
        direction: l.direction,
        amount: l.amount,
      })),
      reference: entry.reference?.type ? entry.reference : null,
      reversalOf: entry.reversalOf?.toString() ?? null,
      postedAt: entry.postedAt,
    });
  });

  /** Audits the books: debits equal credits, and cached balances match the postings. */
  router.get("/v1/ledger/verify", async (req, res) => {
    res.json(await verifyLedger(models, principalOf(req).merchantId, modeOf(req)));
  });

  return router;
}
