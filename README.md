# PayGuard

A payment gateway with built-in fraud detection: merchants create payments through an API, customers pay on a hosted checkout (Razorpay underneath), every rupee is recorded in a double-entry ledger, and every payment is risk-scored in real time.

Work in progress: see [ROADMAP.md](ROADMAP.md) for every planned branch and where it stands.

## Stack

TypeScript on Node.js 22, Express 5, MongoDB 8 (replica set, for transactions) with Mongoose, Redis, Vitest, and React (the hosted checkout now, the dashboard later).

```
apps/
  api/        Express API
  checkout/   hosted payment page (React + Vite)
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

## Payment intents

A payment intent is one attempt to collect an amount from a customer. Servers create them with an API key; customers pay them on the hosted checkout (see [Taking payments with Razorpay](#taking-payments-with-razorpay)).

```bash
curl -X POST localhost:4000/v1/payment_intents \
  -H "Authorization: Bearer sk_test_..." -H "Idempotency-Key: order-1001" \
  -H "Content-Type: application/json" \
  -d '{"amount": 50000, "description": "Order #1001", "receipt": "order_1001"}'
```

Amounts are in paise (`50000` is ₹500.00), with a ₹1 minimum. Ids carry their type (`pi_...`, `evt_...`).

**Lifecycle**

```
requires_payment --> processing --> succeeded
       |                 +--> failed --> processing (the customer retries)
       +--> canceled
```

- **Transitions are conditional updates:** a change only applies if the intent is still in a state that allows it. A late webhook, a double click or a cancel racing a payment can't move a payment backwards or apply twice; the loser gets `409 invalid_state`.
- **Success is one transaction:** the status change, the ledger capture (debit receivable, credit the merchant the amount minus our fee, credit fee revenue) and the event all commit together. A payment is never "succeeded" without its ledger entry. Of three simultaneous success attempts, exactly one posts.
- **Events (a transactional outbox):** every change appends an event (`payment_intent.created`, `payment_intent.succeeded`, ...) in the same transaction. Webhook delivery to merchants will read from it, so an event exists if and only if its change committed.
- **Test mode:** `POST /v1/payment_intents/{id}/test_actions` with `{"outcome": "succeed" | "fail"}` simulates the customer paying, through the same code real payments will use. It's refused in live mode.

**Idempotency keys**, as Stripe does them: send `Idempotency-Key` on any POST and retrying after a timeout returns the first response (`Idempotent-Replayed: true`) instead of creating a second payment.

- The same key with a different request body is refused (`422`), since that's a bug in the caller.
- A retry while the first request is still running gets `409` with `Retry-After`.
- 4xx responses are saved and replayed too; 5xx aren't, so retrying a server error runs it again.
- A key whose request crashed half-way unlocks after 60 seconds.
- Keys are scoped to the merchant and mode, and kept for 24 hours.

| Endpoint                                                                                                      | Needs            |
| ------------------------------------------------------------------------------------------------------------- | ---------------- |
| `POST /v1/payment_intents`, `POST /v1/payment_intents/{id}/cancel`, `.../test_actions`                        | `payments:write` |
| `GET /v1/payment_intents` (`status`, `limit`, `starting_after`), `GET /v1/payment_intents/{id}`, `.../events` | `payments:read`  |
| `POST /v1/payment_intents/{id}/sync` (ask Razorpay now)                                                       | `payments:write` |

## Taking payments with Razorpay

Customers pay on PayGuard's hosted checkout (`apps/checkout`, React). Razorpay's own checkout window collects the card, UPI or netbanking details, so they never pass through PayGuard's code or servers. That keeps PayGuard out of most card-security (PCI) scope.

```
merchant server            PayGuard API                        Razorpay
     | POST /v1/payment_intents |                                  |
     |------------------------->| (returns checkout_url)           |
customer opens checkout_url (apps/checkout)                          |
     |--- GET /v1/checkout/{id} --> first open: create order ------->|
     |<------------------------- amount, merchant, order_id ---------|
     |        Razorpay's window (card / UPI / netbanking) ---------->|
     |--- POST .../confirm (signed result) --> verify signature,     |
     |                            ask Razorpay's API --------------->|
     |                            <------------- payment: captured --|
     |                            succeed: status + ledger + event   |
```

1. **Create** an intent with your API key. The response has a `client_secret` and a `checkout_url` (`{CHECKOUT_URL}/pay/{id}?client_secret=...`). Send the customer there, or build your own page on `GET /v1/checkout/{id}?client_secret=...`.
2. **Open:** the first time the checkout opens, PayGuard creates a Razorpay order for the exact amount. Opening it again, or in five tabs at once, reuses one order (a conditional update keeps exactly one).
3. **Pay:** the checkout gets back Razorpay's signed result. The API checks the HMAC signature (`order_id|payment_id` with our key secret, compared in constant time), then asks Razorpay's API what actually happened instead of trusting the browser.
4. **Capture:** a captured payment succeeds the intent in one transaction, with the status, the ledger capture and the event together. A payment that was only authorized (an account without auto-capture) is captured first. If every attempt failed, the intent fails with the bank's reason and the customer can try again on the same order.

**Safety:**

- **Idempotent settling:** settling is idempotent. The browser confirming twice and the merchant calling `POST /v1/payment_intents/{id}/sync` at the same moment still give one capture and one ledger entry (tested).
- **Razorpay unreachable:** if Razorpay can't be reached while the customer confirms, the intent is parked as `processing` instead of failing. The checkout keeps re-checking, and `sync` finishes it later. (Razorpay's webhooks, next branch, will do this automatically.)
- **Amount mismatch:** a captured amount that doesn't match the intent is never marked paid; it is logged for a person to look at.
- **Canceled intents:** a payment captured after its intent was canceled doesn't bring the intent back to life. It is logged as needing a refund (refunds come in branch 7).
- **Scoped access:** the customer-facing endpoints are scoped to one intent by its client secret, compared in constant time. A wrong id and a wrong secret both give the same `404`, and they are rate limited per IP.
- **Secret in the URL:** the checkout page sends no `Referer`, so the secret in its URL can't leak to other sites.

**Trying it (test mode, free):**

1. Create a Razorpay account and copy the **test** key id and secret (Account & Settings, API Keys) into `RAZORPAY_TEST_KEY_ID` and `RAZORPAY_TEST_KEY_SECRET` in `apps/api/.env`.
2. Run the API (`npm run dev`) and the checkout (`npm run dev:checkout`, on port 5174; it forwards `/v1` to the API).
3. Create a test-mode intent, open its `checkout_url`, and pay with one of [Razorpay's test cards or UPI ids](https://razorpay.com/docs/payments/payments/test-card-details/).

| Endpoint                                  | Who                                                           |
| ----------------------------------------- | ------------------------------------------------------------- |
| `GET /v1/checkout/{id}?client_secret=...` | the customer's browser: amount, merchant name, Razorpay order |
| `POST /v1/checkout/{id}/confirm`          | the customer's browser: Razorpay's signed result              |
| `POST /v1/payment_intents/{id}/sync`      | the merchant (`payments:write`): ask Razorpay now             |

The API tests run against an in-memory fake of Razorpay's API, so they need no keys and never call Razorpay. The checkout's tests (React Testing Library) stand in for Razorpay's window.

## Ledger

Every movement of money is recorded in a double-entry ledger, kept separately per merchant and per mode (test and live).

**Chart of accounts** (balances in paise, positive on the account's normal side):

| Account              | Type      | Means                                                       |
| -------------------- | --------- | ----------------------------------------------------------- |
| `gateway_receivable` | asset     | Captured by the payment gateway, not yet paid out to us     |
| `bank`               | asset     | Settled money                                               |
| `merchant_payable`   | liability | The merchant's balance: what we owe them. Can't go negative |
| `fee_revenue`        | revenue   | Our processing fees                                         |

A ₹100 payment with a 2% fee posts: debit `gateway_receivable` 10000, credit `merchant_payable` 9800, credit `fee_revenue` 200.

**Guarantees**

- **Integer money:** amounts are whole paise, never floats. Decimal strings are parsed digit by digit, fees round half up in integer arithmetic, and splits use largest-remainder allocation, so no paisa is lost or invented.
- **Every entry balances:** debits must equal credits, or nothing is written.
- **Atomic:** the entry, its postings and every affected balance are written in one MongoDB transaction.
- **No overdrafts, even under concurrency:** a balance that can't go negative is decreased with a conditional update that only matches while the balance covers it. Ten concurrent ₹30 refunds against ₹100 give exactly three successes.
- **Idempotent:** every entry has an idempotency key. A retry returns the original entry; the same key with different content is refused (`409`); simultaneous retries still post once.
- **Immutable:** entries and postings can't be updated or deleted. Mistakes are fixed with a reversing entry, and each entry can be reversed once.
- **Auditable:** each posting stores the account's balance right after it, giving running-balance statements. `verifyLedger` checks that total debits equal total credits and that every cached balance equals the sum of its postings.

Property-based tests (fast-check) post random sequences of captures, settlements and refunds and check these invariants after every sequence.

**Trade-off:** every payment updates the same `merchant_payable` document, so a very busy merchant's postings contend on that document, and MongoDB retries the conflicting transactions. At much higher volume, the balance would be split across several sub-accounts and summed on read.

| Endpoint                                  | Who                                                       |
| ----------------------------------------- | --------------------------------------------------------- |
| `GET /v1/ledger/accounts?mode=test`       | anyone with `payments:read` (API keys see their own mode) |
| `GET /v1/ledger/accounts/{code}/postings` | statement with running balances, cursor pagination        |
| `GET /v1/ledger/entries/{id}`             | one entry and its lines                                   |
| `GET /v1/ledger/verify`                   | the audit result                                          |

Entries are posted by the payment flows (next branches), not through the public API.

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
