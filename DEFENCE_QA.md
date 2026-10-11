# Technical Interview & Submission Defence — Questions and Answers

This is the preparation sheet for the recorded defence of the **NestJS Stock Reservation**
submission. Every answer is grounded in the code in this repository. Use it to rehearse
spoken answers; the recording must be completed within **30 minutes after starting**, and
recording consent is required.

The defence is expected to cover four things:

1. **Your implementation** — how it works and why.
2. **Trade-offs** — what you chose and what you gave up.
3. **Tests** — how you know it is correct.
4. **A change you would make** — one concrete improvement.
5. **How you would review an intern's work.**

---

## Part A — Implementation

### Q1. Give the 60-second summary of what you built.

An idempotent, concurrency-safe `POST /reservations` endpoint built with NestJS, Prisma and
PostgreSQL. A client sends a `productId`, a `quantity` and an `Idempotency-Key` header. The
service reserves stock **exactly once per key**: the first request reserves and returns `201`;
any repeat with the same key returns the stored original response as `200` with
`Idempotent-Replayed: true`. Stock can never go negative, even under concurrent load, because
the decrement is a single conditional `UPDATE`.

### Q2. Walk me through a single request end to end.

1. NestJS `ValidationPipe` validates the body against `CreateReservationDto` (UUID product,
   positive integer quantity).
2. The `IdempotencyKey` decorator runs `IdempotencyKeyPipe`, which rejects a missing or
   malformed key with `400`.
3. `ReservationsController.create` calls `ReservationsService.reserve`.
4. The service computes a SHA-256 **fingerprint** of the canonical payload
   (`{ productId, quantity }`).
5. `retryOnTransientError` opens a `READ COMMITTED` transaction and calls `reserveInTransaction`.
6. Inside the transaction it **claims the key** first with
   `INSERT ... ON CONFLICT (idempotencyKey) DO NOTHING` (Prisma `createMany({ skipDuplicates: true })`).
7. If the claim **succeeded**, it decrements stock atomically:
   `UPDATE Product SET stock = stock - $q WHERE id = $id AND stock >= $q`.
8. If the claim **failed**, the key already exists, so it reads the committed row, checks the
   fingerprint, and replays the stored result (`200`) or rejects a payload mismatch (`422`).
9. The idempotency row and the stock change commit or roll back **together**.

### Q3. Why claim the idempotency key *before* touching stock?

Because the key is the serialization point. The unique index on `idempotencyKey` means two
concurrent requests with the same key cannot both insert. The second one blocks on the insert
until the first commits or rolls back, and then its fate is decided against **committed** data:

- First **commits** → the second's insert does nothing, so it reads the committed result and replays.
- First **rolls back** → the second's insert succeeds and it becomes the owner.

If I decremented stock first, two requests with the same key could both take stock before either
claimed the key. Claiming first makes the operation idempotent by construction.

### Q4. Why is `READ COMMITTED` the correct isolation level? Why not `REPEATABLE READ` or `SERIALIZABLE`?

`ON CONFLICT DO NOTHING` blocks on the unique index until the competing transaction finishes.
After that wait, my very next `SELECT` must observe the other transaction's **committed** row.
`READ COMMITTED` takes a fresh snapshot per statement, so it sees that row. Under
`REPEATABLE READ` the transaction's snapshot was taken earlier and would **not** include the
just-committed row, so `findByIdempotencyKey` could return `null` and I would raise a spurious
`500` (`reservations.service.ts:107-113`).

`SERIALIZABLE` would be correct too, but it is stricter than this algorithm needs and would
generate avoidable serialization failures and retries for no correctness benefit. `READ COMMITTED`
plus the unique index plus the conditional `UPDATE` already gives me the guarantees I need.

### Q5. How do you prevent overselling / negative stock?

The decrement is a **single atomic SQL statement**:

```sql
UPDATE "Product" SET stock = stock - $q WHERE id = $id AND stock >= $q
```

There is no read → check → write in application code, so there is no check-then-act race.
PostgreSQL serializes the row-level writes; the losing transaction's `WHERE stock >= quantity`
evaluates false and updates zero rows. `decrementStockIfAvailable` returns `count === 1`
(`prisma-reservation.repository.ts:66-75`), and if that is false the service throws
`ConflictException('Insufficient stock')` → `409`.

As a defence in depth, the database also has `CHECK ("stock" >= 0)`
(`20261008000000_init/migration.sql:38`). So even a future bug that bypasses the service logic
cannot persist negative stock.

### Q6. Why does insufficient stock roll back the key claim?

The claim and the decrement are in the **same transaction**. When `decrementStockIfAvailable`
returns false, I throw `ConflictException`, which aborts the transaction and rolls back the
inserted idempotency row. That means the key is **not consumed** — the client can legitimately
retry the same key later (e.g. after a restock). The unit test
`'rejects when stock is insufficient and leaves the key reusable'`
(`test/reservations.service.spec.ts:73-80`) proves this: it asserts `repository.records.size === 0`
after the `409`, then restocks and reuses the same key successfully.

### Q7. What happens when the same key is reused with a *different* payload?

The stored `requestFingerprint` (SHA-256 of `{ productId, quantity }`) is compared with the
incoming one. If they differ, the service throws `UnprocessableEntityException` → `422`
(`reservations.service.ts:115-119`). This prevents the classic idempotency bug where a client
reuses a key for a genuinely different operation and silently gets an unrelated cached response.
`productId` and `quantity` are deliberately the only fields in the fingerprint because they are
the only inputs that change the outcome.

### Q8. Why is the fingerprint **not** part of the response and why SHA-256?

The fingerprint is internal bookkeeping — clients should not see or depend on it. SHA-256 gives
a fixed 64-char value (`CHAR(64)` column) with negligible collision probability, so two different
payloads never share a fingerprint.

### Q9. How does the "product does not exist" path work? Why is it a `404` and not a constraint crash?

The `ReservationRequest.productId` has a foreign key to `Product(id)` with `ON DELETE RESTRICT`
(`reservation.repository` → migration line 34). If the product does not exist, the insert raises
PostgreSQL error `P2003` (Prisma foreign-key violation). The repository catches exactly that code
and translates it into a domain error `ProductNotFoundError`
(`prisma-reservation.repository.ts:47-55`). The service maps that domain error to
`NotFoundException` → `404` (`reservations.service.ts:53-58`). This keeps the repository
transport-agnostic: it speaks domain errors, and only the service speaks HTTP. Any *other* error
is re-thrown untouched so it is not silently swallowed.

The `RESTRICT` on delete means you cannot delete a product while reservations reference it,
which preserves referential integrity of historical reservations.

### Q10. What are the explicit HTTP status codes and why?

From `README.md` and the mapping in code:

| Status | Meaning | Where |
| ------ | ------- | ----- |
| 201 | New reservation | controller default |
| 200 + `Idempotent-Replayed: true` | Replay of an earlier request | `reservations.controller.ts:28-30` |
| 400 | Invalid body or bad/missing `Idempotency-Key` | `CreationDto`, `idempotency-key.pipe.ts` |
| 404 | Product does not exist | `ProductNotFoundError` → `NotFoundException` |
| 409 | Insufficient stock (key not consumed) | `ConflictException` |
| 422 | Key reused with a different payload | `UnprocessableEntityException` |

`409` vs `422` is a deliberate distinction: `409` is a **transient state conflict** the client
can retry (same request, stock may come back), while `422` is a **semantic** error (the request
itself contradicts a previous one) that retrying will never fix.

### Q11. Explain the retry logic and why you retry the *whole* transaction.

`retryOnTransientError` (`src/common/database/retry.ts`) retries the entire unit of work.
`isTransientDatabaseError` (`src/common/database/transient-error.ts`) classifies three codes:

- `P2034` — Prisma: write conflict / deadlock
- `40001` — PostgreSQL: serialization failure
- `40P01` — PostgreSQL: deadlock detected

It does up to `RESERVATION_TX_MAX_ATTEMPTS` (default 3) attempts with **exponential backoff plus
full jitter** (`Math.random() * baseDelayMs * 2^(attempt-1)`). Jitter matters: without it, two
transactions that just deadlocked retry in lock-step and deadlock again.

I retry the whole transaction rather than just the stock `UPDATE`, because the key claim and the
stock change must stay one atomic unit. If I retried only the update, a partial failure could
leave the key claimed without the stock change (or vice-versa), breaking the invariant.

### Q12. What errors are deliberately *not* retried?

Anything not in the transient set — validation errors, `409`, `422`, `404`, and infrastructure
errors like `connection refused`. Retrying a business rejection like "insufficient stock" would
be wrong (the outcome will not change) and would waste the client's time. Test
`'does not retry non-transient errors'` asserts `transactionCount === 1`
(`test/reservations.service.spec.ts:134-139`).

### Q13. Why include the retry option `sleep` in the signature?

Dependency injection for tests. `retry.ts` accepts `sleep` (defaulting to a real `setTimeout`),
so the retry tests run instantly without real waiting. `maxAttempts` is validated as a positive
integer, throwing `RangeError` otherwise.

### Q14. How is input validated, and why validate at the boundary?

- **Body:** `CreateReservationDto` uses `@IsUUID`, `@IsInt`, `@IsPositive`, `@Max(2_147_483_647)`.
  The `Max` mirrors PostgreSQL `integer` range so an overflow becomes a clean `400` instead of a
  database error.
- **Header:** `IdempotencyKeyPipe` requires a non-empty string, trims it, and enforces
  `1–255` **printable ASCII** characters (`/^[\x21-\x7E]+$/`). Printable-ASCII keeps keys safe to
  log and compare byte-wise, and 255 matches the `VarChar(255)` column.
- The global `ValidationPipe` uses `whitelist: true, forbidNonWhitelisted: true, transform: true`,
  so unknown body fields are rejected and types are coerced.

Failing fast at the boundary means the domain layer only ever sees valid, well-typed input, and
clients get actionable `400`s instead of obscure `500`s.

### Q15. What is the port/adapter structure, and why does it matter?

`ReservationRepository` is an interface ("port") with three methods:
`claimIdempotencyKey`, `findByIdempotencyKey`, `decrementStockIfAvailable`, wrapped by
`transaction` (`repository/reservation.repository.ts`). The Nest provider token is a `Symbol`,
and `PrismaReservationRepository` is the adapter. The service depends **only** on the interface.

Two benefits: (1) the service is unit-testable with an in-memory double, and (2) swapping Prisma
for another ORM means writing one new adapter and changing one module binding. This is also a
direct answer to the AI-disclosure point about the original code injecting a TypeScript
`interface` that Nest can't resolve at runtime — now I inject a **`Symbol` token**.

### Q16. Why does the service catch only `ProductNotFoundError` and re-throw everything else?

So the HTTP translation is intentional and narrow: I map exactly the domain errors I know about,
and let anything unexpected propagate (which NestJS turns into a `500`). This avoids the
anti-pattern of wrapping every error and hiding bugs.

### Q17. The idempotency record stores the response `result` as `JSONB`. Why store the response at all?

So a replay returns **byte-identical** semantics — the same `reservationId`, `quantity`, `status`
— instead of recomputing (which could differ if state changed). The response is written up front
in the same insert, so it is available the instant the row is visible. The `result` is typed as
`Reservation` in the domain and cast at the Prisma boundary (`prisma-reservation.repository.ts:63`).

---

## Part B — Trade-offs

### Q18. What are the biggest trade-offs in this design?

1. **Idempotency rows are permanent.** I never expire or garbage-collect them. Correct and simple,
   but the table grows unbounded. A production system would add a TTL / retention job (see
   Part D). I chose correctness-of-delivery over storage.
2. **No soft "processing" state.** I deliberately removed the `processing` status the original
   draft had. Because the row is only visible after commit and commits with the stock change,
   a half-finished reservation can never be observed. Simplicity over visibility-into-in-flight.
3. **`READ COMMITTED` relies on the unique index for serialization.** It is subtle. A reader who
   doesn't understand `ON CONFLICT` blocking might "simplify" it into a race. I mitigated this
   with comments and this defence doc.
4. **Single-node correctness.** The design is correct across concurrent connections and multiple
   app instances because the coordination lives in PostgreSQL, not in process memory. That is a
   strength, but it means throughput is bounded by the single primary database.
5. **No cancellation/expiry of reservations.** A reservation holds stock forever. That is a
   product decision, not a correctness one; expiry would need a different model.

### Q19. Why PostgreSQL-specific SQL instead of a database-agnostic approach?

Because `INSERT ... ON CONFLICT`, row-level locking and `CHECK` constraints are exactly the
tools that make this provably correct, and they are battle-tested. Portability can hide the
concurrency semantics I rely on. The port/adapter boundary means the database-specific part is
isolated in one place, so the cost of choosing Postgres is contained.

### Q20. Why not use `SELECT ... FOR UPDATE` to lock the product row first?

Because it reads before writing and leaves a window where the key is not yet claimed. Also, a
`FOR UPDATE` lookup on an idempotency key that does not exist yet locks **nothing** — this was the
exact bug found in the original code: two concurrent same-key requests could both pass the lookup
and both reserve stock, and the loser got a `500`. `ON CONFLICT` on a unique index fixes it
because the index itself serializes the insert.

### Q21. Why not distributed locking (Redis) or a database advisory lock?

A unique constraint already gives me a correct, atomic, durable lock with no extra infrastructure.
Redis introduces another failure mode (lock expiry, split brain) and doesn't participate in my
database transaction, so it could not roll back the key claim with the stock change. Keeping
coordination **inside the same transaction** is the whole point.

### Q22. Returning `200` for replays instead of `201` — is that a trade-off?

Yes. It is a deliberate client-visible signal via both the status code and the
`Idempotent-Replayed: true` header, so a client can tell "this was a fresh reservation" from
"this is a replay". The cost is that well-behaved clients must handle `200` as well as `201`.
I judged observability worth it and documented it in the README table.

### Q23. Quantity is a plain integer with no unit/reservation expiry. How would you extend?

The `quantity`/`stock` model stays; I would add a `reservations` table with an expiry timestamp
and a background job that releases expired holds (increment stock back). The key claim would then
matter even more, because retries after expiry must not double-release.

### Q24. Where does the fingerprint canonicalization have a limitation?

It uses `JSON.stringify({ productId, quantity })`. Object key order is stable only because I
construct the object literally with a fixed key order, so the digest is reproducible. If more
fields were added, I would sort keys explicitly to keep canonicalization robust. This is a real
thing to call out rather than pretend it is flawless.

---

## Part C — Tests

### Q25. What does your test suite cover?

`test/reservations.service.spec.ts` (11 tests):

- happy path: reserves stock, returns a new reservation, decrements stock;
- replay of a repeated key does not reserve again and returns the original body;
- key reuse with a different payload → `422`, stock untouched;
- insufficient stock → `409`, key stays reusable;
- unknown product → `404`;
- 20 concurrent distinct-key requests against stock 10 → exactly 10 fulfilled, 10 `409`, stock 0;
- 5 concurrent same-key requests → one `reservationId`, exactly one non-replay, stock decremented once;
- retry: succeeds after transient errors, gives up after `maxAttempts`, does not retry non-transient.

Plus `idempotency-key.pipe.spec.ts`, `retry.spec.ts`, and `env.validation.spec.ts`.

### Q26. The concurrency tests use an in-memory repository. How do you know they prove real database behaviour?

Good challenge — this is why the **Approach.md** and **AI_DISCLOSURE.md** both say the meaningful
concurrency tests must run against a **real PostgreSQL**, because a mock can't prove what the
database does. The in-memory double is used for fast unit-level behaviour (including modelled
transaction rollback and per-key serialization), but the acceptance evidence came from
**HTTP checks against a temporary PostgreSQL container**: concurrent distinct keys, concurrent
same key, replays, payload mismatch, unknown product, insufficient stock. I am explicit that the
unit double is a convenience, not proof of the DB contract.

### Q27. How does the in-memory double model transactions and serialization?

`InMemoryReservationRepository` stages copies of `stock` and `records` and only commits them if
the work function resolves (`replaceContents` at the end). A thrown error simply discards the
staged copies — real rollback semantics. It serializes transactions through a promise `queue`
(`this.queue = run.catch(...)`), mirroring how PostgreSQL serializes writers contending for the
same rows. It also supports `failNextTransactionsWith(...)` to inject transient errors in order,
which is how the retry tests are driven deterministically.

### Q28. How do you test retry without waiting for real backoff?

The retry helper takes an injectable `sleep`. Tests can supply a no-op/controlled sleep, and the
in-memory repo counts `transactionCount`, so I assert exactly how many attempts occurred
(`3` on success, `MAX_ATTEMPTS` on give-up, `1` for non-transient). This makes timing-sensitive
logic deterministic and fast.

### Q29. How do you ensure the concurrency test actually overlaps requests?

The database connection pool must allow at least as many connections as concurrent requests,
otherwise requests queue at the pool and never truly overlap (noted in Approach.md). I size the
pool / concurrency accordingly, and I assert on the observable invariants (exactly 10 fulfilled,
stock 0) rather than on timing, so the test is robust.

### Q30. How do you run everything?

`npm test` (unit), `npm run test:cov` (coverage), `npm run typecheck` (`tsc --noEmit`), and a
temporary PostgreSQL via `npm run db:up` + `npm run prisma:deploy` for the DB-level checks. Jest
runs `ts-jest` over both `src` and `test`.

### Q31. What is *not* covered by tests today, honestly?

- No automated **integration** test in CI that spins up Postgres and runs the concurrency
  scenarios (it was done manually against a container).
- No load/soak test, no coverage of the `PrismaReservationRepository` adapter itself under
  concurrency.
- No test for the fingerprint canonicalization with additional fields.
This honesty matters: these are the first tests I would add (see Part D).

---

## Part D — A change you would make

### Q32. What one change would you make, and how would you justify it?

**Add a Postgres-backed integration test to CI that runs the concurrency scenarios against a
throwaway database.** Right now the strongest guarantees (unique-index blocking, atomic
conditional update, `READ COMMITTED` visibility) are proven by manual container runs and by an
in-memory double. The double can drift from real PostgreSQL semantics. A testcontainers-based
suite in CI would:

- start a real Postgres, run `prisma migrate deploy`, seed a product;
- fire N concurrent distinct-key requests and assert exactly `stock` succeed and the rest `409`;
- fire N concurrent same-key requests and assert one `reservationId`, one non-replay, one decrement;
- assert oversell is impossible and that `CHECK (stock >= 0)` is never violated.

It is the highest-value change because it converts the paper argument into an automated,
regression-proof guarantee, and it is the exact gap I called out in Q31.

*Alternative smaller change I could mention:* add a retention/TTL job for `reservation_requests`
rows (Q18) to bound table growth, or add sorted-key canonicalization for the fingerprint (Q24).
Mention the integration test as the primary answer and these as runners-up.

### Q33. Walk me through the implementation detail of that change.

1. Add a `test/integration/` suite using `testcontainers` (or a CI service container) to launch
   Postgres 16.
2. In `beforeAll`, set `DATABASE_URL`, run `prisma migrate deploy`, then seed a product with known
   stock via a Prisma client.
3. Boot the Nest app with `Test.createTestingModule` + `app.init()`, or call the service directly
   with the real `PrismaReservationRepository`.
4. Use `Promise.allSettled` over N requests; assert counts and final stock, and query the DB
   directly to assert exactly one idempotency row per key.
5. Tear down the container in `afterAll`.
6. Wire it into the CI pipeline as a separate job so it runs on every PR.

---

## Part E — Reviewing an intern's work

### Q34. How would you review an intern's work on something like this?

A structured, kind, specific process:

1. **Understand the goal first.** Read their write-up and confirm they can state the problem —
   for this task, "reserve stock once per key, never oversell." If the framing is wrong,
   nothing else matters.
2. **Check the concurrency reasoning before the code.** I look for the serialization point: what
   makes two concurrent same-key requests agree on one outcome? I probe with follow-ups like
   "what if the two requests arrive at the exact same instant?" and "what happens if the first
   one rolls back?"
3. **Review for check-then-act races.** Read-before-write patterns (`SELECT` then `UPDATE`,
   `SELECT ... FOR UPDATE` on a non-existent row) are the classic trap — that was the bug in the
   original draft here.
4. **Verify the tests actually test behaviour.** I check that concurrency tests run against a real
   database, that they assert invariants (counts, final stock) not timing, and that retries are
   tested with injected failures rather than real sleeps.
5. **Look at error handling and boundaries.** Are the HTTP codes meaningful and distinct? Is
   invalid input rejected at the boundary? Are domain errors separated from transport errors?
6. **Ask them to justify trade-offs.** I want to hear them say what they gave up (e.g. permanent
   idempotency rows) and why.
7. **Feedback style:** lead with what is correct, name the exact line/behaviour to change, explain
   the *why* with a concrete failing scenario, suggest the smallest fix, and let them implement it
   themselves. I review the fix, not just the comment.
8. **Escalate only on fundamentals.** If they can't explain their own serialization point, that's
   a teaching moment, not a rejection — I pair on it.

### Q35. How would you guide an intern who *over-reserves* under concurrency?

Reproduce it first: write a failing concurrent test that shows stock going below zero or two rows
for one key. Then walk the timeline together ("both read stock 10, both write 9") to make the
check-then-act race visible. Then guide them to the fix in layers: (1) make the decrement a single
conditional `UPDATE ... WHERE stock >= quantity`; (2) add the unique index on the key and claim it
with `ON CONFLICT DO NOTHING` before touching stock; (3) add the `CHECK (stock >= 0)` as defence
in depth. Finally, have them convert the reproduction into a permanent regression test. Guiding
them to *derive* the fix teaches the pattern; handing it over does not.

### Q36. How would you adapt your review for a *junior* engineer versus a *senior* one?

For a junior: focus on correctness, clarity and a reproducible failing test; be explicit and
concrete, and pair on the fix. For a senior/ mid-level engineer: focus on trade-offs, failure
modes, operability (metrics, retry budgets, retention), and whether the design generalizes; expect
them to have already enumerated the trade-offs and to defend the isolation-level choice.

---

## Part F — Likely curveball questions

### Q37. Two identical requests arrive at the same millisecond. What exactly happens inside PostgreSQL?

Both compute the same fingerprint and open `READ COMMITTED` transactions. Both attempt the insert
on the unique index. One wins; the other **blocks** on the index. When the winner commits, the
loser's `ON CONFLICT DO NOTHING` resolves to "no insert," `createMany` returns `count = 0`, and
the loser reads the winner's committed row and replays it. Exactly one reservation, one stock
decrement, one row.

### Q38. What if the first request crashes *after* the insert but before the stock update commits?

The whole transaction is aborted, so both the key claim and the (attempted) stock update roll back.
No row, no stock change, and the key is free for a retry. There is no state in which the key is
claimed without the stock change.

### Q39. The client times out and retries with the same key. What does it get?

If the original committed, the retry replays the stored result (`200`, `Idempotent-Replayed: true`)
— it does **not** reserve again. If the original rolled back, the retry becomes the owner and
reserves fresh (`201`). Either way the client converges to exactly one reservation.

### Q40. Can a client get a `500` from the "record vanished" branch?

Only if the isolation level is changed away from `READ COMMITTED`
(`reservations.service.ts:107-113`). Under the design as written it is unreachable; I keep it as an
explicit tripwire so a misconfiguration fails loudly rather than silently mis-replaying. That is
why I documented the isolation choice in the code and in Approach.md.

### Q41. Why do retries use jitter rather than fixed backoff?

Deadlock/serialization partners tend to fail at the same time. Fixed backoff would make them retry
together and collide again in lock-step. Full jitter spreads them out, so the retry succeeds with
high probability within the bounded attempt count.

### Q42. Is the `Idempotency-Key` scoped globally or per product? Any risk?

Currently it is **global** — one row per key across all products. That matches the common
semantics (one key = one logical request). The risk is a client that reuses the same key for two
*legitimately different* reservations of different products; they would get a `422`, which is the
correct, safe outcome. If a client needs per-product keys, it can namespace the key itself. Key
scoping is a documented product decision, not a hidden one.

### Q43. What monitoring would you add in production?

Log structured events for `201` (created), `200` (replayed), `409`, `422`, and every retry attempt
with its error code. Alert on: retry rate spiking (indicates lock contention), a rise in `409`s
(demand exceeds stock), and any `P2003`/`CHECK` violations (indicates a logic or integrity bug).
Track transaction latency and pool saturation (ties back to Q29).

### Q44. How is the app configured safely?

`src/config/env.validation.ts` validates every variable at boot with `class-validator` and throws
with the full list of problems, so the app refuses to start misconfigured. `RESERVATION_TX_MAX_ATTEMPTS`
is bounded `1–10`, `PORT` `1–65535`, `NODE_ENV` is an enum, `DATABASE_URL` is required and non-empty.
No secrets are hard-coded; `.env.example` documents the variables.

### Q45. What did the AI assistant do, and what did you verify? (AI disclosure)

Per `AI_DISCLOSURE.md`: my own work was the original approach (claim-in-transaction, atomic
`stock >= quantity` update, whole-transaction retry), the first code (service/controller/module/
types/schema/atomic SQL/first tests) and the draft write-up. The assistant did code review (found
the un-resolvable injected interface, missing `ts-jest`, and the `SELECT ... FOR UPDATE` on a
non-existent key that locked nothing), helped refactor to a runnable app (`ON CONFLICT DO NOTHING`,
DTO/header validation, exponential backoff + jitter, split HTTP statuses, migrations with `CHECK`s,
docker-compose, README), wrote 23 tests with a transactional in-memory double, ran typecheck/tests
and HTTP checks against a temporary Postgres container, and helped draft `Approach.md`. I reviewed
every change, understand why the key is claimed before stock is touched, why `READ COMMITTED` is
required, and why the whole transaction is retried, and I verified behaviour with the automated
tests and manual Postgres runs. I am responsible for the final submission.

### Q46. If you had ten minutes and one bug report — "we occasionally oversold" — how would you debug it?

Start from the invariant: negative stock or two rows for one key. Check (a) whether the decrement
is still a single conditional `UPDATE` (someone may have reintroduced a read-then-write),
(b) whether the `CHECK (stock >= 0)` constraint still exists, (c) the isolation level on the
transaction, and (d) whether any code path claims the key *after* touching stock. Then reproduce
with a concurrent test at a pool size larger than the concurrency. The design is specifically
built so each of these is easy to inspect.

---

## 30-minute recording plan

A suggested spoken flow that hits all four required points plus the intern question:

1. **Context (1–2 min):** the task, the guarantee (reserve once per key, never oversell).
2. **Implementation (7–9 min):** request path (Q2), claim-before-stock (Q3), `READ COMMITTED`
   (Q4), atomic update (Q5), rollback-on-`409` (Q6), fingerprint/`422` (Q7), status codes (Q10),
   retries (Q11).
3. **Trade-offs (4–5 min):** Q18 (permanent keys, no processing state, single-primary throughput),
   Q21 (why not Redis/distributed lock).
4. **Tests (5–6 min):** Q25, Q26 (real Postgres vs double), Q27, Q28, and the honest gaps (Q31).
5. **A change you would make (3–4 min):** Q32/Q33 — integration test in CI with testcontainers,
   plus the TTL runner-up.
6. **Intern review (4–5 min):** Q34/Q35 — reproduce, derive the fix, permanent regression test.
7. **Close (1 min):** ownership and AI disclosure (Q45).

Keep answers concrete and reference the files by name — `reservations.service.ts`,
`prisma-reservation.repository.ts`, `retry.ts`, `transient-error.ts`,
`reservations.service.spec.ts` — so the reviewer can see the claim maps to real code.
