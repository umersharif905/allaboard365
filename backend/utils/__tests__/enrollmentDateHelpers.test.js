// backend/utils/__tests__/enrollmentDateHelpers.test.js
const {
  calculateNextEffectiveDate,
  calculateEndOfCurrentMonth,
  calculateTerminationDate,
  isFutureEnrollment
} = require('../enrollmentDateHelpers');

describe('enrollmentDateHelpers — characterization (current 1st-of-month behavior)', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-15T12:00:00Z'));
  });
  afterAll(() => jest.useRealTimers());

  describe('calculateNextEffectiveDate', () => {
    it('group member without product returns 1st of next month', () => {
      const member = { GroupId: 'group-1' };
      const result = calculateNextEffectiveDate(member);
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(4); // May (0-indexed)
      expect(result.getUTCDate()).toBe(1);
    });

    it('individual member with first_of_month product returns 1st of next month', () => {
      const member = { GroupId: null };
      const product = { effectiveDateLogic: 'first_of_month' };
      const result = calculateNextEffectiveDate(member, product);
      expect(result.getUTCDate()).toBe(1);
      expect(result.getUTCMonth()).toBe(4); // May (0-indexed)
    });

    it('individual member with no product returns 1st of next month (current default)', () => {
      const member = { GroupId: null };
      const result = calculateNextEffectiveDate(member);
      expect(result.getUTCDate()).toBe(1);
    });

    it('individual member with FIRST_OF_MONTH (uppercase) product still returns 1st', () => {
      const result = calculateNextEffectiveDate({ GroupId: null }, { effectiveDateLogic: 'FIRST_OF_MONTH' });
      expect(result.getUTCDate()).toBe(1);
    });

    it('individual member with non-first_of_month product still returns 1st (current default behavior)', () => {
      const result = calculateNextEffectiveDate({ GroupId: null }, { effectiveDateLogic: 'same_day' });
      expect(result.getUTCDate()).toBe(1);
    });

    describe('household cohort lock', () => {
      it('FIFTEENTH cohort overrides group flag and returns next 15th', () => {
        const member = { GroupId: 'group-1' };
        const group = { AllowMidMonthEffective: true };
        const result = calculateNextEffectiveDate(member, null, group, 'FIFTEENTH');
        // System date is 2026-04-15T12:00:00Z; getNextCohortDate(FIFTEENTH) skips to next month's 15th
        expect(result.getUTCDate()).toBe(15);
        expect(result.getUTCMonth()).toBe(4); // May (next 15th after Apr 15)
      });

      it('FIRST cohort returns next 1st even when group flag is on', () => {
        const member = { GroupId: 'group-1' };
        const group = { AllowMidMonthEffective: true };
        const result = calculateNextEffectiveDate(member, null, group, 'FIRST');
        expect(result.getUTCDate()).toBe(1);
        expect(result.getUTCMonth()).toBe(4); // May
      });

      it('null cohort falls back to group rule (sooner of 1st/15th when flag on)', () => {
        const member = { GroupId: 'group-1' };
        const group = { AllowMidMonthEffective: true };
        // Today is Apr 15 — next 1st is May 1 (16 days), next 15th is May 15 (30 days). Sooner = May 1.
        const result = calculateNextEffectiveDate(member, null, group, null);
        expect(result.getUTCDate()).toBe(1);
      });
    });
  });

  describe('calculateEndOfCurrentMonth', () => {
    it('returns April 30 when today is April 15', () => {
      const result = calculateEndOfCurrentMonth();
      expect(result.getMonth()).toBe(3); // April (0-indexed)
      expect(result.getDate()).toBe(30);
    });

    it('returns Feb 28 in non-leap year when given an explicit billingDate', () => {
      const result = calculateEndOfCurrentMonth(new Date(2026, 1, 10)); // Feb 10 2026 (non-leap)
      expect(result.getMonth()).toBe(1);
      expect(result.getDate()).toBe(28);
    });
  });

  describe('calculateTerminationDate', () => {
    // Use local date constructors (not UTC ISO strings) because the function
    // uses local date arithmetic (setDate/getDate). UTC ISO strings would be
    // shifted by the local timezone offset before local math is applied,
    // producing wrong results on non-UTC machines.

    it('returns day before effective date', () => {
      const effective = new Date(2026, 4, 15); // May 15, local
      const result = calculateTerminationDate(effective);
      expect(result.getDate()).toBe(14);
      expect(result.getMonth()).toBe(4); // May (0-indexed)
    });

    it('crosses month boundary correctly', () => {
      const effective = new Date(2026, 5, 1); // June 1, local
      const result = calculateTerminationDate(effective);
      expect(result.getDate()).toBe(31);
      expect(result.getMonth()).toBe(4); // May (0-indexed)
    });
  });

  describe('isFutureEnrollment', () => {
    it('returns true for tomorrow (Date)', () => {
      expect(isFutureEnrollment(new Date(2026, 3, 16))).toBe(true); // April 16, local
    });

    it('returns false for today (Date)', () => {
      expect(isFutureEnrollment(new Date(2026, 3, 15))).toBe(false); // April 15, local
    });

    it('returns false for yesterday (Date)', () => {
      expect(isFutureEnrollment(new Date(2026, 3, 14))).toBe(false); // April 14, local
    });

    it('returns true for tomorrow given as YYYY-MM-DD string', () => {
      expect(isFutureEnrollment('2026-04-16')).toBe(true);
    });

    it('returns false for today given as YYYY-MM-DD string', () => {
      expect(isFutureEnrollment('2026-04-15')).toBe(false);
    });

    it('returns false for yesterday given as YYYY-MM-DD string', () => {
      expect(isFutureEnrollment('2026-04-14')).toBe(false);
    });

    it('treats ISO date-only prefix as local calendar day (not UTC midnight)', () => {
      expect(isFutureEnrollment('2026-04-16T00:00:00.000Z')).toBe(true);
    });
  });
});

describe('calculateNextEffectiveDate — mid-month support', () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });
  afterAll(() => jest.useRealTimers());

  it('group with allowMidMonth=true on April 10 returns April 15', () => {
    jest.setSystemTime(new Date('2026-04-10T12:00:00Z'));
    const member = { GroupId: 'g1' };
    const group = { AllowMidMonthEffective: true };
    const result = calculateNextEffectiveDate(member, null, group);
    expect(result.getUTCDate()).toBe(15);
    expect(result.getUTCMonth()).toBe(3); // April
  });

  it('group with allowMidMonth=true on April 20 returns May 1', () => {
    jest.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    const member = { GroupId: 'g1' };
    const group = { AllowMidMonthEffective: true };
    const result = calculateNextEffectiveDate(member, null, group);
    expect(result.getUTCDate()).toBe(1);
    expect(result.getUTCMonth()).toBe(4); // May
  });

  it('group with allowMidMonth=false on April 10 still returns May 1', () => {
    jest.setSystemTime(new Date('2026-04-10T12:00:00Z'));
    const member = { GroupId: 'g1' };
    const group = { AllowMidMonthEffective: false };
    const result = calculateNextEffectiveDate(member, null, group);
    expect(result.getUTCDate()).toBe(1);
    expect(result.getUTCMonth()).toBe(4); // May
  });

  it('group param omitted → backward-compatible (always 1st)', () => {
    jest.setSystemTime(new Date('2026-04-10T12:00:00Z'));
    const member = { GroupId: 'g1' };
    const result = calculateNextEffectiveDate(member);
    expect(result.getUTCDate()).toBe(1);
  });
});

const { calculateEndOfCurrentPeriod } = require('../enrollmentDateHelpers');

describe('calculateEndOfCurrentPeriod — cohort-aware', () => {
  beforeAll(() => jest.useFakeTimers());
  afterAll(() => jest.useRealTimers());

  it('for 1st-cohort member, returns last day of calendar month', () => {
    jest.setSystemTime(new Date('2026-04-15T12:00:00Z'));
    const member = { EffectiveDate: new Date('2026-04-01T00:00:00Z') };
    const result = calculateEndOfCurrentPeriod(member);
    expect(result.toISOString().slice(0, 10)).toBe('2026-04-30');
  });

  it('for 15th-cohort member, returns 14th of next calendar month', () => {
    jest.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    const member = { EffectiveDate: new Date('2026-04-15T00:00:00Z') };
    const result = calculateEndOfCurrentPeriod(member);
    expect(result.toISOString().slice(0, 10)).toBe('2026-05-14');
  });

  it('for legacy non-cohort EffectiveDate (e.g., day 10), falls back to calendar end-of-month', () => {
    jest.setSystemTime(new Date('2026-04-15T12:00:00Z'));
    const member = { EffectiveDate: new Date('2026-04-10T00:00:00Z') };
    const result = calculateEndOfCurrentPeriod(member);
    // calculateEndOfCurrentMonth returns local-date last-of-month
    expect(result.getMonth()).toBe(3); // April
  });

  it('for missing EffectiveDate, falls back to calendar end-of-month', () => {
    jest.setSystemTime(new Date('2026-04-15T12:00:00Z'));
    const result = calculateEndOfCurrentPeriod({});
    expect(result.getMonth()).toBe(3);
  });
});
