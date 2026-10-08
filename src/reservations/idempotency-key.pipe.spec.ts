import { BadRequestException } from '@nestjs/common';
import { IdempotencyKeyPipe } from './idempotency-key.pipe';

describe('IdempotencyKeyPipe', () => {
  const pipe = new IdempotencyKeyPipe();

  it('accepts and trims a valid key', () => {
    expect(pipe.transform('  4f9c-key_01  ')).toBe('4f9c-key_01');
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['too long', 'a'.repeat(256)],
    ['containing spaces', 'two words'],
    ['non-ASCII', 'clé'],
  ])('rejects a %s key', (_, value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });
});
