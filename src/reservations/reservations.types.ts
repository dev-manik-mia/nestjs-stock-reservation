export interface ReserveCommand {
  productId: string;
  quantity: number;
  idempotencyKey: string;
}

/** The response body; persisted so retries of the same key replay it. */
export interface Reservation {
  reservationId: string;
  productId: string;
  quantity: number;
  status: 'reserved';
}

export interface ReserveOutcome {
  reservation: Reservation;
  /** True when the response was replayed from an earlier request with the same key. */
  replayed: boolean;
}
