import { AsyncLocalStorage } from "node:async_hooks";

type RequestContext = { requestId: string };

/** Carries the current request's ID through every await, so any log line can include it. */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
