import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Matches the `VarChar(255)` column the key is stored in. */
const MAX_KEY_LENGTH = 255;

/** Printable ASCII only; keeps keys safe to log and compare byte-wise. */
const KEY_PATTERN = /^[\x21-\x7E]+$/;

@Injectable()
export class IdempotencyKeyPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new BadRequestException(
        `The ${IDEMPOTENCY_KEY_HEADER} header is required`,
      );
    }

    const key = value.trim();

    if (key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) {
      throw new BadRequestException(
        `The ${IDEMPOTENCY_KEY_HEADER} header must be 1-${MAX_KEY_LENGTH} printable ASCII characters`,
      );
    }

    return key;
  }
}
