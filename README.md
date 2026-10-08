# NestJS Stock Reservation

An idempotent stock reservation API that is safe under concurrency, built with NestJS, Prisma and PostgreSQL.

## Quick start

```bash
cp .env.example .env          # configure environment (validated at boot)
npm install
npm run db:up                 # local PostgreSQL via docker compose
npm run prisma:deploy         # apply migrations
npm run start:dev
```

| Script                  | Purpose                                    |
| ----------------------- | ------------------------------------------ |
| `npm test`              | Unit tests                                 |
| `npm run test:cov`      | Unit tests with coverage                   |
| `npm run typecheck`     | Type-check sources and tests               |
| `npm run build`         | Compile to `dist/`                         |
| `npm run prisma:migrate`| Create a new migration during development  |

## Configuration

Every variable is documented in [`.env.example`](.env.example) and validated in
`src/config/env.validation.ts`. The app refuses to start if a variable is missing or invalid.

| Variable                      | Default       | Description                                  |
| ----------------------------- | ------------- | -------------------------------------------- |
| `DATABASE_URL`                | — (required)  | PostgreSQL connection string                 |
| `PORT`                        | `3000`        | HTTP port                                    |
| `NODE_ENV`                    | `development` | `development` \| `test` \| `production`      |
| `RESERVATION_TX_MAX_ATTEMPTS` | `3`           | Retries for transient DB errors (1–10)       |

## API

### `POST /reservations`

Headers: `Idempotency-Key: <1–255 printable ASCII chars>` (required)

```json
{ "productId": "6f1c1d3e-8a4b-4c1e-9a7f-2b3c4d5e6f70", "quantity": 2 }
```

| Status | Meaning                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| 201    | Reservation created                                                              |
| 200    | Replay of an earlier request with the same key (`Idempotent-Replayed: true`)     |
| 400    | Invalid body or missing/malformed `Idempotency-Key`                              |
| 404    | Product does not exist                                                           |
| 409    | Insufficient stock (the key is **not** consumed; it can be retried later)        |
| 422    | Key was already used with a different payload                                    |

Response body:

```json
{
  "reservationId": "57726239-a514-4de1-9261-48a30cb69c4c",
  "productId": "6f1c1d3e-8a4b-4c1e-9a7f-2b3c4d5e6f70",
  "quantity": 2,
  "status": "reserved"
}
```

## Design

Each reservation runs in a single `READ COMMITTED` transaction:

1. **Claim the idempotency key:** `INSERT ... ON CONFLICT ("idempotencyKey") DO NOTHING`.
   If another transaction holds the same key uncommitted, PostgreSQL blocks this insert until
   that transaction finishes. The outcome is therefore always decided against committed data.
2. **If the key already exists**, compare the request fingerprint (SHA-256 of the canonical
   payload). If it matches, replay the stored result. If it doesn't, return 422.
3. **Otherwise, decrement stock atomically:**
   `UPDATE "Product" SET stock = stock - $q WHERE id = $id AND stock >= $q`.
   There is no read-then-write, so overselling is impossible. If no row is updated, the
   transaction throws and rolls back, which also releases the key claim.

Transient failures (`P2034`, `40001`, `40P01`) are retried with exponential backoff plus full jitter.

The database also enforces the invariants: a unique index on `idempotencyKey`, `CHECK (stock >= 0)`,
`CHECK (quantity > 0)`, a non-blank product `name`, and a `RESTRICT` foreign key from reservations to products.

### Layout

```
src/
├── main.ts                         # bootstrap: global ValidationPipe, shutdown hooks
├── app.module.ts
├── config/env.validation.ts        # typed, fail-fast env validation
├── prisma/                         # PrismaService lifecycle
├── common/database/                # transient-error detection + retry with backoff
└── reservations/
    ├── reservations.controller.ts  # HTTP mapping (201 / 200 replay)
    ├── reservations.service.ts     # idempotency + reservation workflow
    ├── repository/                 # persistence port + Prisma adapter
    ├── dto/                        # request validation
    └── idempotency-key.*           # header decorator + validation pipe
test/
├── reservations.service.spec.ts    # behaviour, concurrency, retry
└── support/                        # transactional in-memory repository double
```

The service depends only on the `ReservationRepository` port (`RESERVATION_REPOSITORY` token).
Swapping Prisma for another ORM means writing one adapter.
