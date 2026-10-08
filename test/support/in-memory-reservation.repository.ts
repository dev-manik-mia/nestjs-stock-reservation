import {
  ReservationRecord,
  ReservationRepository,
  ReservationTransaction,
} from '../../src/reservations/repository/reservation.repository';
import { ProductNotFoundError } from '../../src/reservations/reservations.errors';

/**
 * Test double with real transactional semantics: writes are staged and only
 * committed if the unit of work resolves, and transactions are serialized the
 * way PostgreSQL serializes writers contending for the same rows.
 */
export class InMemoryReservationRepository implements ReservationRepository {
  readonly stock = new Map<string, number>();
  readonly records = new Map<string, ReservationRecord>();
  transactionCount = 0;

  private queue: Promise<unknown> = Promise.resolve();
  private pendingFailures: unknown[] = [];

  withProduct(productId: string, stock: number): this {
    this.stock.set(productId, stock);
    return this;
  }

  /** The next N transactions throw these errors (in order) before doing any work. */
  failNextTransactionsWith(...errors: unknown[]): this {
    this.pendingFailures.push(...errors);
    return this;
  }

  transaction<T>(work: (tx: ReservationTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.runTransaction(work));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runTransaction<T>(
    work: (tx: ReservationTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactionCount++;

    if (this.pendingFailures.length > 0) {
      throw this.pendingFailures.shift();
    }

    const stock = new Map(this.stock);
    const records = new Map(this.records);

    const tx: ReservationTransaction = {
      claimIdempotencyKey: async (record) => {
        if (!stock.has(record.productId)) {
          throw new ProductNotFoundError(record.productId);
        }
        if (records.has(record.idempotencyKey)) {
          return false;
        }
        records.set(record.idempotencyKey, structuredClone(record));
        return true;
      },
      findByIdempotencyKey: async (key) =>
        structuredClone(records.get(key) ?? null),
      decrementStockIfAvailable: async (productId, quantity) => {
        const available = stock.get(productId);
        if (available === undefined || available < quantity) {
          return false;
        }
        stock.set(productId, available - quantity);
        return true;
      },
    };

    const result = await work(tx);

    replaceContents(this.stock, stock);
    replaceContents(this.records, records);
    return result;
  }
}

function replaceContents<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  source.forEach((value, key) => target.set(key, value));
}
