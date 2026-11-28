import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";

import { ApiError } from "../errors.js";
import { authenticate, requirePermission, userOf } from "../middleware/auth.js";
import { KEY_MODES } from "../models/index.js";
import {
  MISMATCH_TYPES,
  type ReconciliationRun,
  type ReconMismatch,
  type Settlement,
} from "../reconciliation/models.js";
import { parse } from "../validation.js";
import type { RouteDeps } from "./deps.js";

const runsQuery = z.object({
  mode: z.enum(KEY_MODES).optional(),
  limit: z.coerce.number().int().min(1).max(90).default(30),
});

const mismatchQuery = z.object({
  status: z.enum(["open", "resolved"]).optional(),
  type: z.enum(MISMATCH_TYPES).optional(),
  run: z.string().optional(),
  mode: z.enum(KEY_MODES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  starting_after: z.string().optional(),
});

const resolveBody = z.strictObject({
  // What was done about it: the audit trail for whoever looks next
  note: z.string().trim().min(3).max(2000),
});

const settlementsQuery = z.object({
  mode: z.enum(KEY_MODES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** A run as one merchant sees it: the day's status and their own numbers only. */
function runJson(run: ReconciliationRun, merchantId: string) {
  const mine = run.merchants.find((m) => m.merchantId.toString() === merchantId);
  return {
    id: run._id,
    object: "reconciliation_run",
    mode: run.mode,
    date: run.date,
    status: run.status,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    attempts: run.attempts,
    summary: {
      matched: mine?.matched ?? 0,
      mismatches: mine?.mismatches ?? 0,
      gateway_amount: mine?.gatewayAmount ?? 0,
      ledger_amount: mine?.ledgerAmount ?? 0,
      difference: (mine?.gatewayAmount ?? 0) - (mine?.ledgerAmount ?? 0),
      settled_net: mine?.settledNet ?? 0,
    },
  };
}

function mismatchJson(m: ReconMismatch) {
  return {
    id: m._id,
    object: "reconciliation_mismatch",
    run: m.runId,
    mode: m.mode,
    date: m.date,
    type: m.type,
    entity_type: m.entityType,
    entity_id: m.entityId,
    payment_intent: m.paymentIntentId,
    expected: m.expected as unknown,
    actual: m.actual as unknown,
    message: m.message,
    status: m.status,
    resolution: m.resolution,
    resolved_at: m.resolvedAt,
    note: m.note,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
  };
}

function settlementJson(s: Settlement, merchantId: string) {
  const mine = s.merchants.find((m) => m.merchantId.toString() === merchantId);
  return {
    id: s._id,
    object: "settlement",
    mode: s.mode,
    utr: s.utr,
    settled_at: s.settledAt,
    date: s.date,
    // Only this merchant's part of the transfer
    payments: mine?.payments ?? 0,
    refunds: mine?.refunds ?? 0,
    gateway_fees: mine?.fees ?? 0,
    gateway_tax: mine?.tax ?? 0,
    net: mine?.net ?? 0,
    lines: mine?.lines ?? 0,
    ledger_entry_id: mine?.ledgerEntryId?.toString() ?? null,
  };
}

function csvCell(value: unknown): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = value.toString();
  else if (value !== null && value !== undefined) text = JSON.stringify(value);
  // Quote everything; double inner quotes. A leading =, +, - or @ is defused so spreadsheet
  // apps don't run it as a formula (CSV injection)
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function reconciliationRouter(deps: RouteDeps): Router {
  const { models } = deps;
  const router = Router();
  router.use(["/v1/reconciliation", "/v1/settlements"], authenticate(deps));

  router.get(
    "/v1/reconciliation/runs",
    requirePermission("reconciliation:read"),
    async (req, res) => {
      const { merchantId } = userOf(req);
      const query = parse(runsQuery, req.query);
      const rows = await models.ReconciliationRun.find(query.mode ? { mode: query.mode } : {})
        .sort({ date: -1, mode: 1 })
        .limit(query.limit)
        .lean<ReconciliationRun[]>();
      res.json({ object: "list", data: rows.map((r) => runJson(r, merchantId)) });
    },
  );

  router.get(
    "/v1/reconciliation/runs/:id",
    requirePermission("reconciliation:read"),
    async (req, res) => {
      const { merchantId } = userOf(req);
      const run = await models.ReconciliationRun.findById(req.params.id).lean<ReconciliationRun>();
      if (!run) throw new ApiError(404, "not_found", "Reconciliation run not found");
      const byType = await models.ReconMismatch.aggregate<{
        _id: string;
        open: number;
        total: number;
      }>([
        { $match: { runId: run._id, merchantId: new Types.ObjectId(merchantId) } },
        {
          $group: {
            _id: "$type",
            total: { $sum: 1 },
            open: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } },
          },
        },
      ]);
      res.json({
        ...runJson(run, merchantId),
        mismatches_by_type: Object.fromEntries(
          byType.map((t) => [t._id, { open: t.open, total: t.total }]),
        ),
      });
    },
  );

  router.get(
    "/v1/reconciliation/runs/:id/report.csv",
    requirePermission("reconciliation:read"),
    async (req, res) => {
      const { merchantId } = userOf(req);
      const run = await models.ReconciliationRun.findById(req.params.id).lean<ReconciliationRun>();
      if (!run) throw new ApiError(404, "not_found", "Reconciliation run not found");
      const owner = new Types.ObjectId(merchantId);
      const [mismatches, settlements] = await Promise.all([
        models.ReconMismatch.find({ runId: run._id, merchantId: owner })
          .sort({ type: 1 })
          .lean<ReconMismatch[]>(),
        models.Settlement.find({
          mode: run.mode,
          date: run.date,
          "merchants.merchantId": owner,
        }).lean<Settlement[]>(),
      ]);
      const rows: unknown[][] = [
        ["section", "type", "id", "payment_intent", "status", "expected", "actual", "message"],
      ];
      for (const s of settlements) {
        const mine = settlementJson(s, merchantId);
        rows.push([
          "settlement",
          "settlement",
          s._id,
          "",
          "posted",
          { payments: mine.payments, refunds: mine.refunds },
          { fees: mine.gateway_fees, tax: mine.gateway_tax, net: mine.net },
          `UTR ${s.utr ?? "-"}, ${mine.lines} lines`,
        ]);
      }
      for (const m of mismatches) {
        rows.push([
          "mismatch",
          m.type,
          m.entityId,
          m.paymentIntentId,
          m.status,
          m.expected,
          m.actual,
          m.message,
        ]);
      }
      res
        .type("text/csv")
        .attachment(`reconciliation-${run.mode}-${run.date}.csv`)
        .send(rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n");
    },
  );

  router.get(
    "/v1/reconciliation/mismatches",
    requirePermission("reconciliation:read"),
    async (req, res) => {
      const { merchantId } = userOf(req);
      const query = parse(mismatchQuery, req.query);
      const owner = new Types.ObjectId(merchantId);
      const filter: Record<string, unknown> = { merchantId: owner };
      if (query.status) filter.status = query.status;
      if (query.type) filter.type = query.type;
      if (query.run) filter.runId = query.run;
      if (query.mode) filter.mode = query.mode;
      if (query.starting_after) {
        const cursor = await models.ReconMismatch.findOne({
          _id: query.starting_after,
          merchantId: owner,
        }).lean<ReconMismatch>();
        if (!cursor) throw new ApiError(400, "invalid_cursor", "starting_after isn't a mismatch");
        filter.$or = [
          { createdAt: { $lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
        ];
      }
      const rows = await models.ReconMismatch.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(query.limit + 1)
        .lean<ReconMismatch[]>();
      res.json({
        object: "list",
        data: rows.slice(0, query.limit).map(mismatchJson),
        has_more: rows.length > query.limit,
      });
    },
  );

  router.post(
    "/v1/reconciliation/mismatches/:id/resolve",
    requirePermission("reconciliation:manage"),
    async (req, res) => {
      const { merchantId, userId } = userOf(req);
      const body = parse(resolveBody, req.body);
      const updated = await models.ReconMismatch.findOneAndUpdate(
        { _id: req.params.id, merchantId: new Types.ObjectId(merchantId), status: "open" },
        {
          $set: {
            status: "resolved",
            resolution: "manual",
            resolvedAt: new Date(),
            resolvedBy: new Types.ObjectId(userId),
            note: body.note,
          },
        },
        { returnDocument: "after" },
      ).lean<ReconMismatch>();
      if (!updated) {
        const exists = await models.ReconMismatch.exists({
          _id: req.params.id,
          merchantId: new Types.ObjectId(merchantId),
        });
        if (!exists) throw new ApiError(404, "not_found", "Mismatch not found");
        throw new ApiError(409, "already_resolved", "This mismatch is already resolved");
      }
      res.json(mismatchJson(updated));
    },
  );

  router.get("/v1/settlements", requirePermission("reconciliation:read"), async (req, res) => {
    const { merchantId } = userOf(req);
    const query = parse(settlementsQuery, req.query);
    const filter: Record<string, unknown> = {
      "merchants.merchantId": new Types.ObjectId(merchantId),
    };
    if (query.mode) filter.mode = query.mode;
    const rows = await models.Settlement.find(filter)
      .sort({ settledAt: -1 })
      .limit(query.limit)
      .lean<Settlement[]>();
    res.json({ object: "list", data: rows.map((s) => settlementJson(s, merchantId)) });
  });

  router.get("/v1/settlements/:id", requirePermission("reconciliation:read"), async (req, res) => {
    const { merchantId } = userOf(req);
    const settlement = await models.Settlement.findOne({
      _id: req.params.id,
      "merchants.merchantId": new Types.ObjectId(merchantId),
    }).lean<Settlement>();
    if (!settlement) throw new ApiError(404, "not_found", "Settlement not found");
    res.json(settlementJson(settlement, merchantId));
  });

  return router;
}
