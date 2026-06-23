/**
 * Mocked getPool: asserts getOrCreateInvoiceForPayment resolves billing period
 * from unified anchor vs calendar month, without hitting createInvoiceForEnrollment.
 */

jest.mock('../../config/database', () => {
  const sql = require('mssql');
  return {
    getPool: jest.fn(),
    sql,
    rawSql: {}
  };
});

const invoiceService = require('../invoiceService');
const { getPool } = require('../../config/database');

function utcYmd(d) {
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
}

function poolWithAnchorAndExisting(opts) {
  const { anchorIso, paymentOverlapsExisting, existingRow } = opts;
  /** @type {Array<Record<string, unknown>>} */
  const captures = [];

  return {
    request() {
      const inputs = {};
      const idx = captures.length;
      captures.push(inputs);
      return {
        input(name, _type, val) {
          inputs[name] = val;
          return this;
        },
        query: jest.fn(async () => {
          if (idx === 0) {
            return {
              recordset: anchorIso
                ? [{ EffectiveDate: new Date(anchorIso) }]
                : []
            };
          }
          return { recordset: paymentOverlapsExisting ? [existingRow] : [] };
        })
      };
    },
    captures
  };
}

describe('getOrCreateInvoiceForPayment (mocked getPool)', () => {
  const householdId = '22222222-2222-2222-2222-222222222222';
  const tenantId = '33333333-3333-3333-3333-333333333333';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queries overlap using anchor-contained period when enrollment anchor exists', async () => {
    const existingRow = {
      InvoiceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      InvoiceNumber: 'INV-ANCHOR',
      Status: 'Unpaid',
      BillingPeriodStart: new Date('2026-03-25T00:00:00.000Z'),
      BillingPeriodEnd: new Date('2026-03-31T00:00:00.000Z')
    };
    const fake = poolWithAnchorAndExisting({
      anchorIso: '2026-03-25T00:00:00.000Z',
      paymentOverlapsExisting: true,
      existingRow
    });
    getPool.mockResolvedValue(fake);

    const res = await invoiceService.getOrCreateInvoiceForPayment(
      householdId,
      tenantId,
      '2026-04-10T12:00:00.000Z'
    );

    expect(res.created).toBe(false);
    expect(res.invoiceId).toBe(existingRow.InvoiceId);
    const overlapInputs = fake.captures[1];
    expect(utcYmd(overlapInputs.bpStart)).toBe('2026-03-25');
    expect(utcYmd(overlapInputs.bpEnd)).toBe('2026-03-31');
  });

  it('queries overlap using calendar month when no anchor enrollment', async () => {
    const existingRow = {
      InvoiceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      InvoiceNumber: 'INV-CAL',
      Status: 'Unpaid',
      BillingPeriodStart: new Date('2026-04-01T00:00:00.000Z'),
      BillingPeriodEnd: new Date('2026-04-30T00:00:00.000Z')
    };
    const fake = poolWithAnchorAndExisting({
      anchorIso: null,
      paymentOverlapsExisting: true,
      existingRow
    });
    getPool.mockResolvedValue(fake);

    const res = await invoiceService.getOrCreateInvoiceForPayment(
      householdId,
      tenantId,
      '2026-04-10T00:00:00.000Z'
    );

    expect(res.created).toBe(false);
    const overlapInputs = fake.captures[1];
    expect(utcYmd(overlapInputs.bpStart)).toBe('2026-04-01');
    expect(utcYmd(overlapInputs.bpEnd)).toBe('2026-04-30');
  });
});
