'use strict';

const {
  extractHouseholdMemberIdFromRecurringDescription,
  pickDimeScheduleIdFromCustomerUuidCandidates
} = require('../recurringPaymentWebhookApply.service');

describe('extractHouseholdMemberIdFromRecurringDescription', () => {
  test('parses trailing (MEMBERNUMBER) style from description', () => {
    expect(
      extractHouseholdMemberIdFromRecurringDescription({
        description: 'Charles McClain (SW15990904)'
      })
    ).toBe('SW15990904');

    expect(
      extractHouseholdMemberIdFromRecurringDescription({
        description: 'Brian Schoening (SW15990821)'
      })
    ).toBe('SW15990821');

    expect(extractHouseholdMemberIdFromRecurringDescription({ description: 'Monthly Payment' })).toBe(null);
    expect(extractHouseholdMemberIdFromRecurringDescription({})).toBe(null);

    expect(
      extractHouseholdMemberIdFromRecurringDescription({
        description: 'Other (X1) end (MW999)'
      })
    ).toBe('MW999');
  });

  test('fallback fields memo/name', () => {
    expect(
      extractHouseholdMemberIdFromRecurringDescription({
        memo: '(AB12)'
      })
    ).toBe('AB12');
  });
});

describe('pickDimeScheduleIdFromCustomerUuidCandidates', () => {
  const makeRow = (sid, hmid, monthly) => ({
    Sid: sid,
    PrimaryHouseholdMemberId: hmid,
    MonthlyAmount: monthly,
    HouseholdId: '00000000-0000-0000-0000-000000000001'
  });

  test('single candidate returns schedule unchanged', () => {
    const { scheduleId, meta } = pickDimeScheduleIdFromCustomerUuidCandidates(
      [makeRow('S1', 'SW1', 100)],
      { description: 'Any' },
      100,
      {}
    );
    expect(scheduleId).toBe('S1');
    expect(meta.disambiguation).toBe('customer_uuid_single');
    expect(meta.candidateCount).toBe(1);
  });

  test('description disambiguates duplicate customer_uuid households', () => {
    const rows = [
      makeRow('S_A', 'SW15990898', 816.14),
      makeRow('S_B', 'SW15990904', 844.36)
    ];
    const { scheduleId, meta } = pickDimeScheduleIdFromCustomerUuidCandidates(
      rows,
      { description: 'Charles McClain (SW15990904)' },
      844.36,
      {}
    );
    expect(scheduleId).toBe('S_B');
    expect(meta.disambiguation).toBe('description_member_id');
    expect(meta.householdMemberMatched).toBe('SW15990904');
  });

  test('amount disambiguates when description missing but amounts differ uniquely', () => {
    const rows = [
      makeRow('S_A', '', 816.14),
      makeRow('S_B', '', 844.36)
    ];
    const { scheduleId, meta } = pickDimeScheduleIdFromCustomerUuidCandidates(
      rows,
      {},
      816.14,
      {}
    );
    expect(scheduleId).toBe('S_A');
    expect(meta.disambiguation).toBe('monthly_amount');
  });

  test('supports MonthlyAmount vs webhook inclusive of typical $3.50 fee delta', () => {
    const rows = [makeRow('S1', '', 448.17)];
    const { scheduleId } = pickDimeScheduleIdFromCustomerUuidCandidates(
      rows,
      {},
      451.67,
      {}
    );
    expect(scheduleId).toBe('S1');
  });

  test('ambiguous: two candidates same monthly — fail closed', () => {
    const rows = [
      makeRow('S1', 'H1', 100),
      makeRow('S2', 'H2', 100)
    ];
    const { scheduleId, meta } = pickDimeScheduleIdFromCustomerUuidCandidates(rows, {}, 100, {});
    expect(scheduleId).toBe('');
    expect(meta.disambiguation).toBe('ambiguous_multiple_schedules');
    expect(meta.ambiguous).toBe(true);
  });

  test('respects RECURRING_WEBHOOK_DISABLE_AMOUNT_DISAMBIG via opts', () => {
    const rows = [
      makeRow('S_A', '', 100),
      makeRow('S_B', '', 200)
    ];
    const { scheduleId } = pickDimeScheduleIdFromCustomerUuidCandidates(rows, {}, 100, {
      disableAmountDisambig: true
    });
    expect(scheduleId).toBe('');
  });

  test('member id wins when webhook amount mismatches unrelated row', () => {
    const rows = [
      makeRow('S_A', 'OTHER', 816.14),
      makeRow('S_B', 'SW15990904', 844.36)
    ];
    const { scheduleId, meta } = pickDimeScheduleIdFromCustomerUuidCandidates(
      rows,
      { description: 'Charles McClain (SW15990904)' },
      999,
      {}
    );
    expect(scheduleId).toBe('S_B');
    expect(meta.disambiguation).toBe('description_member_id');
  });
});
