import { createHash } from "node:crypto";

import { Types, type ClientSession, type Connection } from "mongoose";

import { ApiError } from "../errors.js";
import type { KeyMode, Models } from "../models/index.js";
import { isDuplicateKey } from "../validation.js";
import { CHART, normalSide, specFor } from "./chart.js";
import type { LedgerAccount, LedgerEntry } from "./models.js";
import { assertAmount, MoneyError, type Currency } from "./money.js";

export type Direction = "debit" | "credit";

export type LineInput = { account: string; direction: Direction; amount: number };

export type EntryInput = {
  merchantId: string | Types.ObjectId;
  mode: KeyMode;
  currency: Currency;
  description: string;
  idempotencyKey: string;
  lines: LineInput[];
  reference?: { type: string; id: string };
};

export type LedgerDeps = { mongo: Connection; models: Models };

function invalid(message: string): ApiError {
  return new ApiError(422, "invalid_entry", message);
}

/** Checks an entry is well formed and balanced before anything touches the database. */
export function validateEntry(input: EntryInput): void {
  if (input.lines.length < 2) throw invalid("An entry needs at least two lines");
  let debits = 0;
  let credits = 0;
  for (const line of input.lines) {
    if (!specFor(line.account)) throw invalid(`Unknown account "${line.account}"`);
    try {
      assertAmount(line.amount, `Amount for ${line.account}`);
    } catch (err) {
      if (err instanceof MoneyError) throw invalid(err.message);
      throw err;
    }
    if (line.direction === "debit") debits += line.amount;
    else credits += line.amount;
  }
  // The rule of double-entry bookkeeping: every entry balances
  if (debits !== credits) {
    throw invalid(`Debits (${debits}) and credits (${credits}) don't balance`);
  }
}

function fingerprint(input: EntryInput): string {
  const content = {
    currency: input.currency,
    description: input.description,
    lines: input.lines.map((l) => [l.account, l.direction, l.amount]),
    reference: input.reference ?? null,
  };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/**
 * Makes sure the merchant has the full chart of accounts in this mode. Upserts, so concurrent
 * callers can't create duplicates (the unique index would refuse them anyway).
 */
export async function ensureAccounts(
  models: Models,
  merchantId: Types.ObjectId,
  mode: KeyMode,
  currency: Currency,
): Promise<Map<string, LedgerAccount>> {
  await models.LedgerAccount.bulkWrite(
    CHART.map((spec) => ({
      updateOne: {
        filter: { merchantId, mode, code: spec.code },
        update: {
          $setOnInsert: {
            merchantId,
            mode,
            code: spec.code,
            name: spec.name,
            type: spec.type,
            currency,
            allowNegative: spec.allowNegative,
            balance: 0,
            debits: 0,
            credits: 0,
          },
        },
        upsert: true,
        // Without this, Mongoose adds `$set: { updatedAt }`, turning every call into a real
        // write to every account: needless I/O, and a write conflict with any transaction
        // that has these accounts in its snapshot
        timestamps: false,
      },
    })),
    { ordered: false },
  );
  const accounts = await models.LedgerAccount.find({ merchantId, mode }).lean();
  return new Map(accounts.map((a) => [a.code, a as LedgerAccount]));
}

async function findByKey(
  models: Models,
  merchantId: Types.ObjectId,
  mode: KeyMode,
  idempotencyKey: string,
): Promise<LedgerEntry | null> {
  return models.LedgerEntry.findOne({ merchantId, mode, idempotencyKey }).lean<LedgerEntry>();
}

export type PostResult = { entry: LedgerEntry; created: boolean };

/**
 * Posts a balanced entry: writes it, its postings, and every affected account's balance in
 * one transaction, so the ledger is never seen half-updated. Safe to retry with the same
 * idempotency key: the first call posts, later calls return the same entry.
 */
export async function postEntry(
  deps: LedgerDeps,
  input: EntryInput,
  extra: {
    reversalOf?: Types.ObjectId;
    /** Post inside the caller's transaction, so the entry commits or aborts with its other writes. */
    session?: ClientSession;
  } = {},
): Promise<PostResult> {
  validateEntry(input);
  const { mongo, models } = deps;
  const merchantId = new Types.ObjectId(input.merchantId.toString());
  const hash = fingerprint(input);

  const replay = async (): Promise<PostResult | null> => {
    const existing = await findByKey(models, merchantId, input.mode, input.idempotencyKey);
    if (!existing) return null;
    if (existing.fingerprint !== hash) {
      throw new ApiError(
        409,
        "idempotency_conflict",
        "This idempotency key was already used for a different entry",
      );
    }
    return { entry: existing, created: false };
  };

  const earlier = await replay();
  if (earlier) return earlier;

  const accounts = await ensureAccounts(models, merchantId, input.mode, input.currency);
  // One currency (INR) for now. Multiple currencies would mean one set of accounts per
  // currency, since an entry can only balance within a single currency.

  const entryId = new Types.ObjectId();
  const postedAt = new Date();
  const write = async (session: ClientSession) => {
    await models.LedgerEntry.create(
      [
        {
          _id: entryId,
          merchantId,
          mode: input.mode,
          currency: input.currency,
          description: input.description,
          idempotencyKey: input.idempotencyKey,
          fingerprint: hash,
          lines: input.lines.map((line) => ({
            accountId: (accounts.get(line.account) as LedgerAccount)._id,
            accountCode: line.account,
            direction: line.direction,
            amount: line.amount,
          })),
          reference: input.reference,
          reversalOf: extra.reversalOf ?? null,
          postedAt,
        },
      ],
      { session },
    );
    await applyLines(models, session, accounts, input.lines, entryId, merchantId, postedAt);
  };
  if (extra.session) {
    // The caller owns the transaction: its retry logic handles conflicts and duplicates
    await write(extra.session);
    const entry = await models.LedgerEntry.findById(entryId)
      .session(extra.session)
      .lean<LedgerEntry>();
    if (!entry) throw new Error("Entry missing right after posting");
    return { entry, created: true };
  }
  try {
    await mongo.transaction(write);
  } catch (err) {
    // Two posts with the same key raced: the loser's transaction aborted on the unique index
    if (isDuplicateKey(err)) {
      const raced = await replay();
      if (raced) return raced;
      if (extra.reversalOf) {
        throw new ApiError(409, "already_reversed", "This entry has already been reversed");
      }
    }
    throw err;
  }

  const entry = await models.LedgerEntry.findById(entryId).lean<LedgerEntry>();
  if (!entry) throw new Error("Entry missing right after posting");
  return { entry, created: true };
}

/**
 * Moves the balances. Each account gets one conditional $inc: if it may not go negative, the
 * update only matches while the balance covers the decrease, so two concurrent refunds can't
 * both spend the same money. A refused update aborts the whole transaction.
 */
async function applyLines(
  models: Models,
  session: ClientSession,
  accounts: Map<string, LedgerAccount>,
  lines: LineInput[],
  entryId: Types.ObjectId,
  merchantId: Types.ObjectId,
  postedAt: Date,
): Promise<void> {
  const byAccount = new Map<string, LineInput[]>();
  for (const line of lines)
    byAccount.set(line.account, [...(byAccount.get(line.account) ?? []), line]);

  // A fixed order, so concurrent entries touching the same accounts meet them in the same order
  const codes = [...byAccount.keys()].sort();
  const postings = [];
  for (const code of codes) {
    const account = accounts.get(code) as LedgerAccount;
    const accountLines = byAccount.get(code) as LineInput[];
    const side = normalSide(account.type);
    const signed = (l: LineInput) => (l.direction === side ? l.amount : -l.amount);
    const delta = accountLines.reduce((sum, l) => sum + signed(l), 0);
    const debits = accountLines
      .filter((l) => l.direction === "debit")
      .reduce((s, l) => s + l.amount, 0);
    const credits = accountLines
      .filter((l) => l.direction === "credit")
      .reduce((s, l) => s + l.amount, 0);

    const filter =
      delta < 0 && !account.allowNegative
        ? { _id: account._id, balance: { $gte: -delta } }
        : { _id: account._id };
    const updated = await models.LedgerAccount.findOneAndUpdate(
      filter,
      { $inc: { balance: delta, debits, credits } },
      { session, returnDocument: "after" },
    ).lean();
    if (!updated && !("balance" in filter)) {
      // Not a balance problem: the account isn't visible to this transaction (created after
      // its snapshot). Callers passing a session must run ensureAccounts() first.
      throw new Error(`Ledger account ${code} not found inside the transaction`);
    }
    if (!updated) {
      throw new ApiError(
        409,
        "insufficient_balance",
        `The ${code} balance is too low for this entry`,
      );
    }

    // Running balance after each line, working back from the final balance
    let balance = updated.balance - delta;
    for (const line of accountLines) {
      balance += signed(line);
      postings.push({
        entryId,
        accountId: account._id,
        merchantId,
        direction: line.direction,
        amount: line.amount,
        balanceAfter: balance,
        postedAt,
      });
    }
  }
  await models.LedgerPosting.insertMany(postings, { session });
}

/** Undoes an entry with a new entry of opposite lines. The original is never touched. */
export async function reverseEntry(
  deps: LedgerDeps,
  merchantId: Types.ObjectId | string,
  entryId: string,
  description?: string,
): Promise<PostResult> {
  const original = await deps.models.LedgerEntry.findOne({
    _id: entryId,
    merchantId,
  }).lean<LedgerEntry>();
  if (!original) throw new ApiError(404, "not_found", "Ledger entry not found");
  return postEntry(
    deps,
    {
      merchantId: original.merchantId,
      mode: original.mode,
      currency: original.currency,
      description: description ?? `Reversal of: ${original.description}`,
      idempotencyKey: `reversal:${original._id.toString()}`,
      lines: original.lines.map((line) => ({
        account: line.accountCode,
        direction: line.direction === "debit" ? "credit" : "debit",
        amount: line.amount,
      })),
      reference: { type: "ledger_entry", id: original._id.toString() },
    },
    { reversalOf: original._id },
  );
}

export type Verification = {
  balanced: boolean;
  totalDebits: number;
  totalCredits: number;
  mismatches: { code: string; cached: number; fromPostings: number }[];
};

/**
 * Audits a merchant's books: total debits must equal total credits (the trial balance), and
 * every cached balance must equal the sum of that account's postings.
 */
export async function verifyLedger(
  models: Models,
  merchantId: Types.ObjectId | string,
  mode: KeyMode,
): Promise<Verification> {
  const accounts = await models.LedgerAccount.find({ merchantId, mode }).lean();
  const sums = await models.LedgerPosting.aggregate<{
    _id: Types.ObjectId;
    debits: number;
    credits: number;
  }>([
    { $match: { accountId: { $in: accounts.map((a) => a._id) } } },
    {
      $group: {
        _id: "$accountId",
        debits: { $sum: { $cond: [{ $eq: ["$direction", "debit"] }, "$amount", 0] } },
        credits: { $sum: { $cond: [{ $eq: ["$direction", "credit"] }, "$amount", 0] } },
      },
    },
  ]);
  const byAccount = new Map(sums.map((s) => [s._id.toString(), s]));

  let totalDebits = 0;
  let totalCredits = 0;
  const mismatches: Verification["mismatches"] = [];
  for (const account of accounts) {
    const sum = byAccount.get(account._id.toString()) ?? { debits: 0, credits: 0 };
    totalDebits += sum.debits;
    totalCredits += sum.credits;
    const fromPostings =
      normalSide(account.type) === "debit" ? sum.debits - sum.credits : sum.credits - sum.debits;
    if (fromPostings !== account.balance) {
      mismatches.push({ code: account.code, cached: account.balance, fromPostings });
    }
  }
  return {
    balanced: totalDebits === totalCredits && mismatches.length === 0,
    totalDebits,
    totalCredits,
    mismatches,
  };
}
