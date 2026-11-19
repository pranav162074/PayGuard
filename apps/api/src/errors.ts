/** An error with a stable, machine-readable code that clients can rely on. */
export class ApiError extends Error {
  override name = "ApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type ErrorBody = {
  error: { code: string; message: string; details?: unknown };
};

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
