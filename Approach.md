# Approach: Idempotent, Concurrency-Safe Stock Reservation

## Summary

I use a unique constraint on `idempotency_key` and claim the key with
`INSERT … ON CONFLICT DO NOTHING`, in the **same transaction** as the stock update.

The key is claimed **before** stock is touched. If another transaction holds the same key but
hasn't committed, PostgreSQL blocks my insert until that transaction finishes:

- **It commits:** my insert does nothing, and I read its committed result.
- **It rolls back:** my insert succeeds and I own the key.

So every decision is made against committed data. Exactly one request reserves stock, and all
the others replay its result.

The stock update is one atomic `UPDATE … WHERE stock >= quantity`, so concurrent requests can
never push stock below zero. A `CHECK` constraint backs this up.

## Database

```sql
CREATE TABLE products (
    id          UUID PRIMARY KEY,
    name        VARCHAR(255) NOT NULL CHECK (btrim(name) <> ''),
    stock       INTEGER NOT NULL CHECK (stock >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reservation_requests (
    id                   UUID PRIMARY KEY,
    idempotency_key      VARCHAR(255) NOT NULL UNIQUE,
    request_fingerprint  CHAR(64) NOT NULL,          -- SHA-256 of the canonical payload
    product_id           UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity             INTEGER NOT NULL CHECK (quantity > 0),
    result               JSONB NOT NULL,             -- response replayed on retries
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX reservation_requests_product_id_idx ON reservation_requests(product_id);
```

There is no `status` column. The row only becomes visible when it commits, and it commits
together with the stock change. So a "processing" state can never be observed.

### Isolation level

I use `READ COMMITTED`, and that choice matters. After `ON CONFLICT` waits, the next
`SELECT` must see the other transaction's committed row. A `REPEATABLE READ` snapshot would
hide it.

## Pseudocode

```typescript
// Input is validated at the HTTP boundary (DTO + header pipe) → 400 on failure:
// productId is a UUID, quantity is a positive integer,
// idempotencyKey is 1–255 printable ASCII characters.

async function reserve(input: {
    productId: string;
    quantity: number;
    idempotencyKey: string;
}): Promise<{ reservation: Reservation; replayed: boolean }> {
    const fingerprint = sha256(JSON.stringify({
        productId: input.productId,
        quantity: input.quantity,
    }));

    // Retry the WHOLE transaction on deadlock / serialization failure,
    // with bounded exponential backoff + jitter.
    return withTransactionRetry({ isolation: "READ COMMITTED" }, async (tx) => {
        const reservation = {
            reservationId: uuid(),
            productId: input.productId,
            quantity: input.quantity,
            status: "reserved",
        };

        // 1. Atomically claim the key, storing the final result up front.
        //    INSERT ... ON CONFLICT (idempotency_key) DO NOTHING
        //    Blocks if another transaction holds this key uncommitted.
        //    Foreign key violation → product does not exist → 404.
        const claimed = await tx.reservationRequests.insertOnConflictDoNothing({
            id: reservation.reservationId,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: fingerprint,
            productId: input.productId,
            quantity: input.quantity,
            result: reservation,
        });

        if (!claimed) {
            // 2. The key belongs to an already-COMMITTED request, so it is
            //    visible under READ COMMITTED. No lock needed: the row is immutable.
            const existing = await tx.reservationRequests.findByIdempotencyKey(
                input.idempotencyKey,
            );

            if (!existing) {
                // Unreachable under READ COMMITTED; signals a misconfiguration.
                throw new InternalServerError("Idempotency record vanished after conflict");
            }

            if (existing.requestFingerprint !== fingerprint) {
                throw new UnprocessableEntity(                        // 422
                    "Idempotency key was already used with a different payload",
                );
            }

            return { reservation: existing.result, replayed: true };   // 200
        }

        // 3. We own the key. Decrement stock atomically:
        //    UPDATE products SET stock = stock - $q
        //    WHERE id = $id AND stock >= $q
        const updated = await tx.products.updateMany({
            where: { id: input.productId, stock: { gte: input.quantity } },
            data: { stock: { decrement: input.quantity } },
        });

        if (updated.count !== 1) {
            // Throwing rolls back the claim too, so the key is NOT used up
            // and the client may retry it later.
            throw new Conflict("Insufficient stock");                 // 409
        }

        return { reservation, replayed: false };                       // 201
    });
}
```

The idempotency record and the stock change commit in one transaction. If anything fails,
both roll back, so a reservation record never exists without its stock change, and the
reverse is also true.

## HTTP responses

| Status | Meaning                                                                      |
| ------ | ---------------------------------------------------------------------------- |
| 201    | Reservation created                                                          |
| 200    | Replay of an earlier request with the same key (`Idempotent-Replayed: true`) |
| 400    | Invalid body or missing/malformed `Idempotency-Key`                          |
| 404    | Product does not exist                                                       |
| 409    | Insufficient stock (the key is not used up and can be retried later)         |
| 422    | Key was already used with a different payload                                |

## Concurrency tests

These run against a real PostgreSQL, not mocks. A mock can't prove what the database does.

```typescript
const initialStock = 10;

beforeEach(async () => {
    await resetDatabase();
    productId = await createProduct({ name: "Widget", stock: initialStock });
});

it("reserves stock only once for the same idempotency key", async () => {
    const input = { productId, quantity: 2, idempotencyKey: "same-key" };

    const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => reserve(input)),
    );

    const ids = new Set(outcomes.map(o => o.reservation.reservationId));
    expect(ids.size).toBe(1);
    expect(outcomes.filter(o => !o.replayed)).toHaveLength(1);

    expect((await getProduct(productId)).stock).toBe(initialStock - 2);
    expect(await countReservations("same-key")).toBe(1);
});

it("never oversells under concurrent requests with different keys", async () => {
    const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
            reserve({ productId, quantity: 1, idempotencyKey: `key-${i}` }),
        ),
    );

    const fulfilled = results.filter(r => r.status === "fulfilled");
    const rejected = results.filter(r => r.status === "rejected");

    expect(fulfilled).toHaveLength(initialStock);
    expect(rejected).toHaveLength(20 - initialStock);
    rejected.forEach(r => expect(r.reason).toBeInstanceOf(Conflict));

    expect((await getProduct(productId)).stock).toBe(0);
});

it("rejects reuse of a key with a different payload", async () => {
    await reserve({ productId, quantity: 2, idempotencyKey: "k" });

    await expect(
        reserve({ productId, quantity: 3, idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(UnprocessableEntity);

    expect((await getProduct(productId)).stock).toBe(initialStock - 2);
});
```

The database connection pool must allow at least as many connections as the concurrent
requests in a test. Otherwise the requests queue up and never actually overlap.

## Retries

For deadlocks (`40P01`) and serialization failures (`40001`, or Prisma's `P2034`), I retry the
**entire transaction**, at most 3 times, with exponential backoff and random jitter. Retrying
only the stock update would separate it from the idempotency claim, and the two must stay one
atomic operation.

## Implementation

The approach is implemented in this repository:

- **Workflow:** `src/reservations/reservations.service.ts`
- **Prisma persistence:** `src/reservations/repository/prisma-reservation.repository.ts`
  (`createMany({ skipDuplicates: true })` compiles to `ON CONFLICT DO NOTHING`)
- **Retry with backoff:** `src/common/database/retry.ts`
- **Schema and constraints:** `prisma/schema.prisma` and `prisma/migrations/`
