const { isFirstOfMonth } = require('../groupPaymentScheduler');

describe('groupPaymentScheduler — isFirstOfMonth', () => {
  beforeAll(() => jest.useFakeTimers());
  afterAll(() => jest.useRealTimers());

  it('returns true on day 1', () => {
    jest.setSystemTime(new Date('2026-04-01T12:00:00Z'));
    expect(isFirstOfMonth()).toBe(true);
  });

  it('returns false on day 15', () => {
    jest.setSystemTime(new Date('2026-04-15T12:00:00Z'));
    expect(isFirstOfMonth()).toBe(false);
  });
});
