import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RESERVATION_REPOSITORY } from '../src/reservations/repository/reservation.repository';
import { RESERVATIONS_OPTIONS } from '../src/reservations/reservations.options';
import { ReservationsService } from '../src/reservations/reservations.service';
import { InMemoryReservationRepository } from './support/in-memory-reservation.repository';

const PRODUCT_ID = '6f1c1d3e-8a4b-4c1e-9a7f-2b3c4d5e6f70';
const UNKNOWN_PRODUCT_ID = '00000000-0000-4000-8000-000000000000';
const MAX_ATTEMPTS = 3;

const transientError = (code = 'P2034') =>
  Object.assign(new Error('write conflict'), { code });

describe('ReservationsService', () => {
  let repository: InMemoryReservationRepository;
  let service: ReservationsService;

  beforeEach(async () => {
    repository = new InMemoryReservationRepository().withProduct(PRODUCT_ID, 10);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReservationsService,
        { provide: RESERVATION_REPOSITORY, useValue: repository },
        {
          provide: RESERVATIONS_OPTIONS,
          useValue: { transactionMaxAttempts: MAX_ATTEMPTS },
        },
      ],
    }).compile();

    service = moduleRef.get(ReservationsService);
  });

  const reserve = (idempotencyKey: string, quantity = 2, productId = PRODUCT_ID) =>
    service.reserve({ productId, quantity, idempotencyKey });

  it('reserves stock and returns a new reservation', async () => {
    const { reservation, replayed } = await reserve('key-1');

    expect(replayed).toBe(false);
    expect(reservation).toEqual({
      reservationId: expect.any(String),
      productId: PRODUCT_ID,
      quantity: 2,
      status: 'reserved',
    });
    expect(repository.stock.get(PRODUCT_ID)).toBe(8);
  });

  it('replays the original result for a repeated key without reserving again', async () => {
    const first = await reserve('key-1');
    const second = await reserve('key-1');

    expect(second).toEqual({ reservation: first.reservation, replayed: true });
    expect(repository.stock.get(PRODUCT_ID)).toBe(8);
  });

  it('rejects reuse of a key with a different payload', async () => {
    await reserve('key-1', 2);

    await expect(reserve('key-1', 3)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(repository.stock.get(PRODUCT_ID)).toBe(8);
  });

  it('rejects when stock is insufficient and leaves the key reusable', async () => {
    await expect(reserve('key-1', 11)).rejects.toBeInstanceOf(ConflictException);
    expect(repository.stock.get(PRODUCT_ID)).toBe(10);
    expect(repository.records.size).toBe(0);

    repository.stock.set(PRODUCT_ID, 20);
    await expect(reserve('key-1', 11)).resolves.toMatchObject({ replayed: false });
  });

  it('returns 404 for an unknown product', async () => {
    await expect(reserve('key-1', 1, UNKNOWN_PRODUCT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('never oversells under concurrent requests with distinct keys', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => reserve(`key-${i}`, 1)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    rejected.forEach((r) =>
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException),
    );
    expect(repository.stock.get(PRODUCT_ID)).toBe(0);
  });

  it('reserves once when the same key is sent concurrently', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => reserve('key-1')),
    );

    const reservationIds = new Set(outcomes.map((o) => o.reservation.reservationId));
    expect(reservationIds.size).toBe(1);
    expect(outcomes.filter((o) => !o.replayed)).toHaveLength(1);
    expect(repository.stock.get(PRODUCT_ID)).toBe(8);
  });

  describe('transient database errors', () => {
    it('retries and succeeds', async () => {
      repository.failNextTransactionsWith(transientError('P2034'), transientError('40P01'));

      await expect(reserve('key-1')).resolves.toMatchObject({ replayed: false });
      expect(repository.transactionCount).toBe(3);
      expect(repository.stock.get(PRODUCT_ID)).toBe(8);
    });

    it(`gives up after ${MAX_ATTEMPTS} attempts`, async () => {
      repository.failNextTransactionsWith(
        ...Array.from({ length: MAX_ATTEMPTS }, () => transientError('40001')),
      );

      await expect(reserve('key-1')).rejects.toMatchObject({ code: '40001' });
      expect(repository.transactionCount).toBe(MAX_ATTEMPTS);
      expect(repository.stock.get(PRODUCT_ID)).toBe(10);
    });

    it('does not retry non-transient errors', async () => {
      repository.failNextTransactionsWith(new Error('connection refused'));

      await expect(reserve('key-1')).rejects.toThrow('connection refused');
      expect(repository.transactionCount).toBe(1);
    });
  });
});
