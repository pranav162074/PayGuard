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
