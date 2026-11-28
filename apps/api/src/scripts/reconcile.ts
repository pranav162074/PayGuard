/**
 * Reconciles a day by hand (the nightly job does yesterday by itself):
 *
 *     npm run reconcile -w apps/api -- --date 2026-11-27 --mode test
 *
 * Without --date: yesterday, India time. Without --mode: every mode with Razorpay keys.
 */
import { parseArgs } from "node:util";

import { loadConfig } from "../config.js";
import { connectMongo } from "../db.js";
import { createLogger } from "../logger.js";
import { registerModels } from "../models/index.js";
import { createGateways } from "../payments/checkout.js";
import { reconcileDay } from "../reconciliation/schedule.js";

const { values } = parseArgs({
  options: { date: { type: "string" }, mode: { type: "string" } },
});
if (values.mode && values.mode !== "test" && values.mode !== "live") {
  console.error("--mode must be test or live");
  process.exit(2);
}

const config = loadConfig();
const logger = createLogger(config.logLevel);
const mongo = await connectMongo(config.mongoUrl);
try {
  const models = registerModels(mongo);
  const deps = {
    mongo,
    models,
    feeBasisPoints: config.platformFeeBps,
    gateways: createGateways(config),
    logger,
  };
  const runs = await reconcileDay(deps, config, {
    date: values.date,
    modes: values.mode ? [values.mode as "test" | "live"] : undefined,
  });
  for (const id of runs) {
    const run = await models.ReconciliationRun.findById(id).lean();
    console.log(`${run?.mode} ${run?.date}: ${run?.status}`, JSON.stringify(run?.counts));
  }
} finally {
  await mongo.close();
}
