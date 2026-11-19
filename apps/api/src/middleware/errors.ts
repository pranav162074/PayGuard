import type { ErrorRequestHandler, RequestHandler } from "express";
import type { Logger } from "pino";

import { ApiError, errorBody } from "../errors.js";

export const notFound: RequestHandler = (req, _res, next) => {
  next(new ApiError(404, "not_found", `No route for ${req.method} ${req.path}`));
};

// Errors thrown by express.json() carry a `type` saying what went wrong
type BodyParserError = Error & { type?: string; status?: number };

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (err instanceof ApiError) {
      res.status(err.status).json(errorBody(err.code, err.message, err.details));
      return;
    }

    const parserError = err as BodyParserError;
    if (parserError.type === "entity.parse.failed") {
      res.status(400).json(errorBody("invalid_json", "The request body is not valid JSON"));
      return;
    }
    if (parserError.type === "entity.too.large") {
      res.status(413).json(errorBody("payload_too_large", "The request body is too large"));
      return;
    }

    // Anything else is a bug: log it in full, but tell the client nothing about internals
    logger.error({ err, method: req.method, path: req.path }, "Unhandled error");
    res
      .status(500)
      .json(
        errorBody("internal_error", "Something went wrong. Quote the request ID if you report it."),
      );
  };
}
