import { Body, Controller, HttpStatus, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { IdempotencyKey } from './idempotency-key.decorator';
import { ReservationsService } from './reservations.service';
import { Reservation } from './reservations.types';

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  /**
   * 201 for a new reservation; 200 plus `Idempotent-Replayed: true` when the
   * response is replayed for a repeated idempotency key.
   */
  @Post()
  async create(
    @IdempotencyKey() idempotencyKey: string,
    @Body() dto: CreateReservationDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Reservation> {
    const { reservation, replayed } = await this.reservationsService.reserve({
      productId: dto.productId,
      quantity: dto.quantity,
      idempotencyKey,
    });

    if (replayed) {
      response.status(HttpStatus.OK).setHeader('Idempotent-Replayed', 'true');
    }

    return reservation;
  }
}
