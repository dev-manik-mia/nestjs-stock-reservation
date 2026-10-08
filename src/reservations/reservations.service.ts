import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { retryOnTransientError } from '../common/database/retry';
import {
  RESERVATION_REPOSITORY,
  ReservationRepository,
  ReservationTransaction,
} from './repository/reservation.repository';
import { ProductNotFoundError } from './reservations.errors';
import {
  RESERVATIONS_OPTIONS,
  ReservationsOptions,
} from './reservations.options';
import {
  Reservation,
  ReserveCommand,
  ReserveOutcome,
} from './reservations.types';

@Injectable()
export class ReservationsService {
  constructor(
    @Inject(RESERVATION_REPOSITORY)
    private readonly repository: ReservationRepository,
    @Inject(RESERVATIONS_OPTIONS)
    private readonly options: ReservationsOptions,
  ) {}

  /**
   * Reserves stock exactly once per idempotency key.
   *
   * The key is claimed *before* stock is touched, inside the same transaction:
   * - Concurrent requests with the same key serialize on the unique index;
   *   the loser waits, then replays the winner's committed result.
   * - Any failure (e.g. insufficient stock) rolls back the claim as well, so
   *   the client may safely retry the same key later.
   */
  async reserve(command: ReserveCommand): Promise<ReserveOutcome> {
    const fingerprint = this.fingerprint(command);

    try {
      return await retryOnTransientError(
        () => this.reserveInTransaction(command, fingerprint),
        { maxAttempts: this.options.transactionMaxAttempts },
      );
    } catch (error) {
      if (error instanceof ProductNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  private reserveInTransaction(
    command: ReserveCommand,
    fingerprint: string,
  ): Promise<ReserveOutcome> {
    return this.repository.transaction(async (tx) => {
      const reservation: Reservation = {
        reservationId: randomUUID(),
        productId: command.productId,
        quantity: command.quantity,
        status: 'reserved',
      };

      const claimed = await tx.claimIdempotencyKey({
        id: reservation.reservationId,
        idempotencyKey: command.idempotencyKey,
        requestFingerprint: fingerprint,
        productId: command.productId,
        quantity: command.quantity,
        result: reservation,
      });

      if (!claimed) {
        return this.replay(command.idempotencyKey, fingerprint, tx);
      }

      const decremented = await tx.decrementStockIfAvailable(
        command.productId,
        command.quantity,
      );

      if (!decremented) {
        // Throwing rolls back the claim, so the key is not burned.
        throw new ConflictException('Insufficient stock');
      }

      return { reservation, replayed: false };
    });
  }

  private async replay(
    idempotencyKey: string,
    fingerprint: string,
    tx: ReservationTransaction,
  ): Promise<ReserveOutcome> {
    const existing = await tx.findByIdempotencyKey(idempotencyKey);

    if (!existing) {
      // The claim reported a conflicting committed row, so it must be visible
      // under READ COMMITTED. Reaching this means the isolation level changed.
      throw new InternalServerErrorException(
        'Idempotency record vanished after conflict',
      );
    }

    if (existing.requestFingerprint !== fingerprint) {
      throw new UnprocessableEntityException(
        'Idempotency key was already used with a different request payload',
      );
    }

    return { reservation: existing.result, replayed: true };
  }

  /** Stable hash of the fields that define "the same request". */
  private fingerprint({ productId, quantity }: ReserveCommand): string {
    return createHash('sha256')
      .update(JSON.stringify({ productId, quantity }))
      .digest('hex');
  }
}
