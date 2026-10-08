import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from '../config/env.validation';
import { PrismaReservationRepository } from './repository/prisma-reservation.repository';
import { RESERVATION_REPOSITORY } from './repository/reservation.repository';
import { ReservationsController } from './reservations.controller';
import {
  RESERVATIONS_OPTIONS,
  ReservationsOptions,
} from './reservations.options';
import { ReservationsService } from './reservations.service';

@Module({
  controllers: [ReservationsController],
  providers: [
    ReservationsService,
    { provide: RESERVATION_REPOSITORY, useClass: PrismaReservationRepository },
    {
      provide: RESERVATIONS_OPTIONS,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
      ): ReservationsOptions => ({
        transactionMaxAttempts: config.get('RESERVATION_TX_MAX_ATTEMPTS', {
          infer: true,
        }),
      }),
    },
  ],
  exports: [ReservationsService],
})
export class ReservationsModule {}
