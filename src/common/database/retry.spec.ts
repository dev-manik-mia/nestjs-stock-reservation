import { retryOnTransientError } from './retry';

describe('retryOnTransientError', () => {
  const sleep = jest.fn().mockResolvedValue(undefined);
  const transient = Object.assign(new Error('deadlock'), { code: '40P01' });

  beforeEach(() => sleep.mockClear());

  it('returns immediately on success', async () => {
    const operation = jest.fn().mockResolvedValue('ok');

    await expect(retryOnTransientError(operation, { maxAttempts: 3, sleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('backs off within an exponentially growing window', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.999);
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValue('ok');

    await retryOnTransientError(operation, { maxAttempts: 3, baseDelayMs: 100, sleep });

    expect(sleep.mock.calls.map(([ms]) => Math.round(ms))).toEqual([100, 200]);
    jest.restoreAllMocks();
  });

  it('recognises codes nested in Prisma raw-query error metadata', async () => {
    const wrapped = Object.assign(new Error('raw query failed'), {
      code: 'P2010',
      meta: { code: '40001' },
    });
    const operation = jest.fn().mockRejectedValueOnce(wrapped).mockResolvedValue('ok');

    await expect(retryOnTransientError(operation, { maxAttempts: 2, sleep })).resolves.toBe('ok');
  });

  it('rejects an invalid attempt count', async () => {
    await expect(retryOnTransientError(jest.fn(), { maxAttempts: 0 })).rejects.toThrow(RangeError);
  });
});
