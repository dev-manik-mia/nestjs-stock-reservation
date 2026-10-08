import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductNotFoundError } from '../reservations.errors';
import { Reservation } from '../reservations.types';
import {
  ReservationRecord,
  ReservationRepository,
  ReservationTransaction,
} from './reservation.repository';

const FOREIGN_KEY_VIOLATION = 'P2003';

@Injectable()
export class PrismaReservationRepository implements ReservationRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: ReservationTransaction) => Promise<T>): Promise<T> {
    // READ COMMITTED is deliberate: after `ON CONFLICT DO NOTHING` waits for a
    // competing transaction, the follow-up SELECT must see its committed row.
    // A REPEATABLE READ snapshot would hide it.
    return this.prisma.$transaction(
      (client) => work(new PrismaReservationTransaction(client)),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}

class PrismaReservationTransaction implements ReservationTransaction {
  constructor(private readonly client: Prisma.TransactionClient) {}

  async claimIdempotencyKey(record: ReservationRecord): Promise<boolean> {
    try {
      // On PostgreSQL, `skipDuplicates` compiles to ON CONFLICT DO NOTHING.
      const { count } = await this.client.reservationRequest.createMany({
        data: {
          id: record.id,
          idempotencyKey: record.idempotencyKey,
          requestFingerprint: record.requestFingerprint,
          productId: record.productId,
          quantity: record.quantity,
          result: record.result as unknown as Prisma.InputJsonObject,
        },
        skipDuplicates: true,
      });
      return count === 1;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === FOREIGN_KEY_VIOLATION
      ) {
        throw new ProductNotFoundError(record.productId);
      }
      throw error;
    }
  }

  async findByIdempotencyKey(key: string): Promise<ReservationRecord | null> {
    const row = await this.client.reservationRequest.findUnique({
      where: { idempotencyKey: key },
    });

    return row && { ...row, result: row.result as unknown as Reservation };
  }

  async decrementStockIfAvailable(
    productId: string,
    quantity: number,
  ): Promise<boolean> {
    const { count } = await this.client.product.updateMany({
      where: { id: productId, stock: { gte: quantity } },
      data: { stock: { decrement: quantity } },
    });
    return count === 1;
  }
}
