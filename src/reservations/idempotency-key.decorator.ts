import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKeyPipe } from './idempotency-key.pipe';

const IdempotencyKeyHeader = createParamDecorator(
  (_: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<Request>().header(IDEMPOTENCY_KEY_HEADER),
);

/** Injects the validated `Idempotency-Key` request header. */
export const IdempotencyKey = (): ParameterDecorator =>
  IdempotencyKeyHeader(undefined, IdempotencyKeyPipe);
