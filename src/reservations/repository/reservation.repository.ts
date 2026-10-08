import { Reservation } from '../reservations.types';

export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');

export interface ReservationRecord {
  id: string;
  idempotencyKey: string;
  requestFingerprint: string;
  productId: string;
  quantity: number;
  result: Reservation;
}

/** Operations available inside a single database transaction. */
export interface ReservationTransaction {
  /**
   * Inserts the record unless its idempotency key already exists
   * (`INSERT ... ON CONFLICT DO NOTHING`). If another transaction holds an
   * uncommitted row with the same key, this blocks until that transaction
   * finishes, so the outcome is always decided against committed data.
   *
   * @returns `true` if this transaction now owns the key.
   * @throws ProductNotFoundError if the product does not exist.
   */
  claimIdempotencyKey(record: ReservationRecord): Promise<boolean>;

  findByIdempotencyKey(key: string): Promise<ReservationRecord | null>;

  /**
   * Atomically decrements stock only if enough is available
   * (`UPDATE ... SET stock = stock - $q WHERE id = $id AND stock >= $q`).
   *
   * @returns `true` if the stock was decremented.
   */
  decrementStockIfAvailable(
    productId: string,
    quantity: number,
  ): Promise<boolean>;
}

export interface ReservationRepository {
  /** Runs `work` in one transaction; any thrown error rolls it back. */
  transaction<T>(work: (tx: ReservationTransaction) => Promise<T>): Promise<T>;
}
