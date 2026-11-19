import { pino, type DestinationStream, type Logger } from "pino";

import { currentRequestId } from "./context.js";

export type { Logger };

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "payguard-api" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      // Every log line written while handling a request carries its ID
      mixin: () => {
        const requestId = currentRequestId();
        return requestId ? { requestId } : {};
      },
      // Secrets must never reach the logs
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        censor: "[redacted]",
      },
    },
    destination,
  );
}
