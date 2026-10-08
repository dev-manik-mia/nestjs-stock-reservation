import { IsInt, IsPositive, IsUUID, Max } from 'class-validator';

/** Largest value a PostgreSQL `integer` column can hold. */
const MAX_INT32 = 2_147_483_647;

export class CreateReservationDto {
  @IsUUID()
  productId: string;

  @IsInt()
  @IsPositive()
  @Max(MAX_INT32)
  quantity: number;
}
