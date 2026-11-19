import { Router } from "express";

import { runChecks, type Check } from "../health.js";

export function healthRouter(checks: Record<string, Check>, timeoutMs: number): Router {
  const router = Router();

  // Liveness: the process is up. Needs no dependencies, so a database outage doesn't get
  // healthy containers restarted.
  router.get("/health/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: send traffic here only if MongoDB and Redis both answer in time
  router.get("/health/ready", async (_req, res) => {
    const result = await runChecks(checks, timeoutMs);
    res.status(result.ready ? 200 : 503).json({
      status: result.ready ? "ok" : "unavailable",
      checks: result.checks,
    });
  });

  return router;
}
