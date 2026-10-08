# AI Assistance Disclosure

I used **Claude Code (Anthropic, model Claude Opus 5.5)** as an AI coding assistant for parts of this submission.

## My own work

- The original approach: claiming the idempotency key inside the same transaction as the stock reservation, the atomic `stock >= quantity` update, and retrying the whole transaction on transient errors.
- The initial code: the reservations service, controller, module, types, Prisma schema, the atomic stock SQL and the first unit tests.
- The draft write-up of the approach, pseudocode and concurrency tests.

## What the AI assistant did

### Code review

It found these problems in my initial code:

- The service injected a TypeScript interface that NestJS can't resolve at runtime.
- Jest couldn't run the TypeScript tests because `ts-jest` wasn't set up.
- A `SELECT … FOR UPDATE` lookup on a key that didn't exist yet locked nothing. So two concurrent requests with the same key could both take stock, and the losing request got a 500 error instead of the original result.

### Refactoring and implementation

- Restructured the project into a runnable NestJS app: bootstrap, environment validation, and a `.env.example` file.
- Added a Prisma repository behind an interface.
- Changed the key claim to `INSERT … ON CONFLICT DO NOTHING` under `READ COMMITTED`.
- Added request validation for the body and the `Idempotency-Key` header.
- Made the retries use exponential backoff with random jitter.
- Split errors into separate HTTP statuses (400 / 404 / 409 / 422, and 200 for replays).
- Added database migrations with CHECK constraints, a `name` field on `Product`, a docker-compose setup and the README.

### Testing

- Wrote unit tests using an in-memory repository that commits and rolls back like a real transaction (23 tests).
- Ran the typecheck and the tests.
- Ran HTTP checks against a temporary PostgreSQL container: concurrent requests with different keys and with the same key, replays, payload mismatch, unknown product and insufficient stock.

### Documentation

It reviewed my approach write-up, suggested corrections, and drafted `Approach.md`. The corrections were:

- The second transaction waits on `ON CONFLICT`; it doesn't fail.
- The "record not found, retry" branch can't happen under `READ COMMITTED`.
- The `processing` status and the second update aren't needed.
- The schema needed a foreign key, a request fingerprint and `TIMESTAMPTZ` columns.
- The tests should run against a real database.

## How I verified the output

I reviewed every AI-generated change and understand the design decisions in it: why the key is claimed before stock is touched, why `READ COMMITTED` is required, and why the whole transaction is retried. The behavior was checked with the automated tests and with manual runs against PostgreSQL. I am responsible for the final submission.
