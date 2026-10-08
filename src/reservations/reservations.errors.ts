/**
 * Domain errors raised by the persistence layer. The service translates them
 * into HTTP exceptions so the repository stays transport-agnostic.
 */
export class ProductNotFoundError extends Error {
  constructor(readonly productId: string) {
    super(`Product ${productId} not found`);
    this.name = ProductNotFoundError.name;
  }
}
