export const RESERVATIONS_OPTIONS = Symbol('RESERVATIONS_OPTIONS');

export interface ReservationsOptions {
  /** Attempts for a transaction aborted by a transient database error. */
  transactionMaxAttempts: number;
}
