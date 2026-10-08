import { validateEnvironment } from './env.validation';

describe('validateEnvironment', () => {
  const DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

  it('applies defaults and coerces numeric strings', () => {
    expect(validateEnvironment({ DATABASE_URL, PORT: '8080' })).toMatchObject({
      NODE_ENV: 'development',
      PORT: 8080,
      DATABASE_URL,
      RESERVATION_TX_MAX_ATTEMPTS: 3,
    });
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => validateEnvironment({})).toThrow(/DATABASE_URL/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => validateEnvironment({ DATABASE_URL, PORT: '70000' })).toThrow(/PORT/);
  });
});
