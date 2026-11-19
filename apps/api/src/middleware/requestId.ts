import { randomUUID } from "node:crypto";

import type { RequestHandler } from "express";

import { requestContext } from "../context.js";

export const REQUEST_ID_HEADER = "x-request-id";

// A caller's ID is kept only if it is short and plain, so it can't inject fake log lines
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

declare module "express-serve-static-core" {
  interface Request {
    id: string;
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get(REQUEST_ID_HEADER);
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID().replaceAll("-", "");
  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  requestContext.run({ requestId: id }, next);
};
