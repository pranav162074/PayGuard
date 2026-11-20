# PayGuard

A payment gateway with built-in fraud detection: merchants create payments through an API, customers pay on a hosted checkout (Razorpay underneath), every rupee is recorded in a double-entry ledger, and every payment is risk-scored in real time.

Work in progress.

## Stack

TypeScript on Node.js 22, Express 5, MongoDB 8 (replica set, for transactions) with Mongoose, Redis, Vitest, and React for the dashboard and checkout (coming).

```
apps/
  api/        Express API
docker-compose.yml   MongoDB (single-node replica set) and Redis for development and tests
```

## Running locally

Requirements: Node.js 22+, Docker Desktop.

```bash
docker compose up -d --wait     # MongoDB on localhost:27018, Redis on localhost:6381
npm install

cp apps/api/.env.example apps/api/.env     # Windows: copy apps\api\.env.example apps\api\.env
npm run dev
```

- `GET /health/live`: the process is running.
- `GET /health/ready`: MongoDB (as a writable replica set primary) and Redis both answer. Returns `503` with per-dependency status otherwise.

Every response carries an `X-Request-ID` header, and every log line written while handling a request includes the same ID. Errors always look like `{"error": {"code": "...", "message": "..."}}`.

## Accounts and authentication

A merchant is a business. People log in to the dashboard and belong to one or more merchants with a role; servers call the API with secret keys.

| Endpoint                                                                                                    | Who                               |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `POST /v1/auth/signup`, `/login`, `/refresh`, `/logout`, `/accept-invitation`                               | anyone                            |
| `POST /v1/auth/logout-all`, `GET /v1/me`                                                                    | logged in                         |
| `GET /v1/team`                                                                                              | any member                        |
| `POST /v1/team/invitations`, `DELETE /v1/team/invitations/{id}`, `PATCH`/`DELETE /v1/team/members/{userId}` | owner                             |
| `POST`/`GET`/`DELETE /v1/api-keys`                                                                          | owner, developer (analysts can't) |

**Dashboard sessions**

- Login returns a 15-minute **access token** (a JWT, checked by signature alone) in the body, and a **refresh token** in an `httpOnly`, `SameSite=Strict` cookie scoped to `/v1/auth`. Page scripts can't read the cookie, and other sites can't make the browser send it.
- **Refresh tokens rotate**: every refresh marks the old token used and issues a new one. Presenting a used token again means someone has a copy, so the whole session is revoked and the user must log in again. The check-and-mark is one conditional update, so two simultaneous refreshes can't both win.
- A session ends a fixed time after login (`REFRESH_TOKEN_TTL_DAYS`); refreshing doesn't extend it. Each refresh re-reads the membership, so role changes apply at the next refresh and removed members are logged out.
- Trade-off: access tokens aren't checked against the database, so a logout or role change takes up to one access-token lifetime to reach a token already issued.

**Passwords**: scrypt (built into Node, memory-hard), with the cost stored in each hash so it can be raised later. Unknown emails are checked against a dummy hash, so login takes the same time either way and responses don't reveal which emails exist.

**Teams**: owners invite by email with a role (the token is returned in the response until email sending exists). A merchant always keeps at least one owner, even when two owners demote each other at the same moment: both transactions also write the merchant document, so MongoDB aborts one of them instead of letting both pass.

**API keys**: `sk_test_...` and `sk_live_...`, shown once, stored as SHA-256 hashes. Keys can use the payments API but never manage the account.

**Rate limits**: sliding windows in Redis (one Lua script, so concurrent requests can't slip past): per API key or user, per IP and per email for login, per IP for signup. Responses carry `RateLimit-*` headers, and a `429` has `Retry-After`. If Redis is down, requests are allowed.

## Checks

The same checks CI runs on every pull request:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Tests use their own database (`payguard_test`) and Redis database 15, so they never touch development data.
