'use strict';

const { compareCustomerSchedules } = require('../dimeScheduleAudit');

const dbMap = (entries) => new Map(Object.entries(entries));

describe('compareCustomerSchedules', () => {
  it('flags an active DIME schedule with no DB row as orphan (McCallister #600 pattern)', () => {
    const f = compareCustomerSchedules({
      customerUuid: '9c282c77',
      dimeSchedules: [
        { id: 600, amount: '362.69', status: 'Active', name: 'Monthly Payment', next_run_date: '2026-07-01T04:00:00Z' },
        { id: 1155, amount: '362.69', status: 'Active', name: 'Lindley McCallister', next_run_date: '2026-07-01T04:00:00Z' }
      ],
      dbByScheduleId: dbMap({ '1155': { amount: 362.69, active: true, source: 'individual' } })
    });
    expect(f.orphans).toHaveLength(1);
    expect(f.orphans[0].scheduleId).toBe('600');
    // two active schedules for one customer = double-charge
    expect(f.multipleActive).toHaveLength(1);
    expect(f.multipleActive[0].scheduleIds).toEqual(['600', '1155']);
  });

  it('flags DIME/DB amount mismatch (Beckner #1184: DIME $12.28 vs DB $389.72)', () => {
    const f = compareCustomerSchedules({
      customerUuid: 'c2609522',
      dimeSchedules: [{ id: 1184, amount: '12.28', status: 'Active', name: 'Makala Beckner', next_run_date: '2026-07-01T04:00:00Z' }],
      dbByScheduleId: dbMap({ '1184': { amount: 389.72, active: true, source: 'individual' } })
    });
    expect(f.orphans).toHaveLength(0);
    expect(f.amountMismatches).toHaveLength(1);
    expect(f.amountMismatches[0]).toMatchObject({ scheduleId: '1184', dimeAmount: 12.28, dbAmount: 389.72 });
    expect(f.multipleActive).toHaveLength(0);
  });

  it('a matching schedule produces no findings', () => {
    const f = compareCustomerSchedules({
      customerUuid: '9f76ff80',
      dimeSchedules: [{ id: 704, amount: '712.92', status: 'Active', name: 'Annette Willey' }],
      dbByScheduleId: dbMap({ '704': { amount: 712.92, active: true, source: 'individual' } })
    });
    expect(f.orphans).toHaveLength(0);
    expect(f.amountMismatches).toHaveLength(0);
    expect(f.multipleActive).toHaveLength(0);
  });

  it('cancelled DIME schedules are ignored entirely', () => {
    const f = compareCustomerSchedules({
      customerUuid: '8fa7fcf9',
      dimeSchedules: [
        { id: 265, amount: '3.50', status: 'Cancelled' },
        { id: 156, amount: '179.63', status: 'Cancelled' }
      ],
      dbByScheduleId: dbMap({})
    });
    expect(f.orphans).toHaveLength(0);
    expect(f.amountMismatches).toHaveLength(0);
    expect(f.multipleActive).toHaveLength(0);
  });

  it('a DB row that is inactive still prevents orphan classification but amount mismatch reports dbActive', () => {
    const f = compareCustomerSchedules({
      customerUuid: 'abc',
      dimeSchedules: [{ id: 920, amount: '402.00', status: 'Active' }],
      dbByScheduleId: dbMap({ '920': { amount: 402, active: false, source: 'individual' } })
    });
    expect(f.orphans).toHaveLength(0);
    expect(f.amountMismatches).toHaveLength(0); // amounts match — schedule known, just deactivated in DB
  });

  it('handles empty inputs', () => {
    const f = compareCustomerSchedules({ customerUuid: 'x', dimeSchedules: [], dbByScheduleId: dbMap({}) });
    expect(f.orphans).toHaveLength(0);
    expect(f.amountMismatches).toHaveLength(0);
    expect(f.multipleActive).toHaveLength(0);
  });
});

describe('parseMoney (DIME thousands-separator strings)', () => {
  const { parseMoney } = require('../dimeScheduleAudit');
  const { parseDimeMoney } = require('../dimeLedgerAudit');

  it.each([
    ['1,536.17', 1536.17],
    ['16,486.36', 16486.36],
    ['389.72', 389.72],
    ['0.01', 0.01],
    [972.63, 972.63],
    ['', 0],
    [null, 0],
    [undefined, 0]
  ])('parses %p as %p', (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
    expect(parseDimeMoney(input)).toBe(expected);
  });

  it('comma amounts no longer produce false mismatches (Robinhood "1,536.17" pattern)', () => {
    const f = compareCustomerSchedules({
      customerUuid: '023440bc',
      dimeSchedules: [{ id: 1032, amount: '1,536.17', status: 'Active', name: 'Robinhood Roofing' }],
      dbByScheduleId: dbMap({ '1032': { amount: 1536.17, active: true, source: 'group' } })
    });
    expect(f.amountMismatches).toHaveLength(0);
  });
});

describe('group mid-month schedule drift (DIME = linked invoice, DB = next month roster)', () => {
  const refJune12 = new Date('2026-06-12T12:00:00Z');

  it('suppresses Park Central #1028 pattern when next run is >3 days away', () => {
    const f = compareCustomerSchedules({
      customerUuid: '13726886-9e16-4575-837b-e2d9a3831496',
      dimeSchedules: [{
        id: 1028,
        amount: '1583.05',
        status: 'Active',
        name: 'Park Central Metal Fabricators - Primary Location',
        next_run_date: '2026-07-05T04:00:00Z'
      }],
      dbByScheduleId: dbMap({
        '1028': {
          amount: 1631.33,
          active: true,
          source: 'group',
          linkedInvoiceTotal: 1583.05
        }
      }),
      referenceDate: refJune12
    });
    expect(f.amountMismatches).toHaveLength(0);
  });

  it('suppresses AiOS #1009 when DIME is higher than DB but matches linked invoice', () => {
    const f = compareCustomerSchedules({
      customerUuid: '448f0278-d044-4070-b103-7082726175dc',
      dimeSchedules: [{
        id: 1009,
        amount: '1803.81',
        status: 'Active',
        name: 'AiOS Group - Primary Location',
        next_run_date: '2026-07-05T04:00:00Z'
      }],
      dbByScheduleId: dbMap({
        '1009': {
          amount: 1637.44,
          active: true,
          source: 'group',
          linkedInvoiceTotal: 1803.81
        }
      }),
      referenceDate: refJune12
    });
    expect(f.amountMismatches).toHaveLength(0);
  });

  it('still flags when DIME matches neither DB nor linked invoice total', () => {
    const f = compareCustomerSchedules({
      customerUuid: 'group-bad',
      dimeSchedules: [{
        id: 9999,
        amount: '1000.00',
        status: 'Active',
        name: 'Bad Group',
        next_run_date: '2026-07-05T04:00:00Z'
      }],
      dbByScheduleId: dbMap({
        '9999': {
          amount: 1631.33,
          active: true,
          source: 'group',
          linkedInvoiceTotal: 1583.05
        }
      }),
      referenceDate: refJune12
    });
    expect(f.amountMismatches).toHaveLength(1);
    expect(f.amountMismatches[0].dimeAmount).toBe(1000);
  });

  it('still flags stale group schedule within 3 days of next run (scheduler missed refresh)', () => {
    const f = compareCustomerSchedules({
      customerUuid: '13726886-9e16-4575-837b-e2d9a3831496',
      dimeSchedules: [{
        id: 1028,
        amount: '1583.05',
        status: 'Active',
        name: 'Park Central Metal Fabricators - Primary Location',
        next_run_date: '2026-06-14T04:00:00Z'
      }],
      dbByScheduleId: dbMap({
        '1028': {
          amount: 1631.33,
          active: true,
          source: 'group',
          linkedInvoiceTotal: 1583.05
        }
      }),
      referenceDate: refJune12
    });
    expect(f.amountMismatches).toHaveLength(1);
    expect(f.amountMismatches[0]).toMatchObject({
      scheduleId: '1028',
      dimeAmount: 1583.05,
      dbAmount: 1631.33
    });
  });

  it('individual mismatches are never suppressed by linked invoice logic', () => {
    const f = compareCustomerSchedules({
      customerUuid: 'c2609522',
      dimeSchedules: [{ id: 1184, amount: '12.28', status: 'Active', next_run_date: '2026-07-01T04:00:00Z' }],
      dbByScheduleId: dbMap({
        '1184': {
          amount: 389.72,
          active: true,
          source: 'individual',
          linkedInvoiceTotal: 12.28
        }
      }),
      referenceDate: refJune12
    });
    expect(f.amountMismatches).toHaveLength(1);
  });
});

describe('module exports', () => {
  it('exports everything the timer imports', () => {
    const mod = require('../dimeScheduleAudit');
    expect(typeof mod.runScheduleAudit).toBe('function');
    expect(typeof mod.compareCustomerSchedules).toBe('function');
  });

  it('timer module loads without throwing', () => {
    expect(() => require('../../DimePaymentStatusAuditTimer/index.js')).not.toThrow();
  });
});
