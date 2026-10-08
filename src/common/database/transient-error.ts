/**
 * Error codes worth retrying because the transaction was aborted by the
 * database's concurrency control, not because the request itself is invalid.
 *
 * - P2034: Prisma — transaction failed due to a write conflict or deadlock
 * - 40001: PostgreSQL — serialization_failure
 * - 40P01: PostgreSQL — deadlock_detected
 */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'P2034',
  '40001',
  '40P01',
]);

export function isTransientDatabaseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { code, meta } = error as {
    code?: unknown;
    meta?: { code?: unknown };
  };

  return (
    (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) ||
    (typeof meta?.code === 'string' && TRANSIENT_ERROR_CODES.has(meta.code))
  );
}
