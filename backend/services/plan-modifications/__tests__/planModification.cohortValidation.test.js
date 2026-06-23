/**
 * Validation guard added to planModification.buildPlan: rejects an effectiveDate
 * (or any per-row effectiveDateEdits.newEffectiveDate) that doesn't match the
 * household cohort + group AllowMidMonthEffective. Defense-in-depth so admins
 * can't bypass the wizard's date picker and create mixed-cohort households.
 */

jest.mock('../../../config/database');
jest.mock('../../householdCohort.service', () => ({
  getHouseholdCohortByMemberId: jest.fn()
}));

const { getPool } = require('../../../config/database');
const { getHouseholdCohortByMemberId } = require('../../householdCohort.service');
const planMod = require('../planModification.service');

function makePool({ memberRow, groupRow }) {
  // Sequence:
  //   1. getMemberContext SELECT  → memberRow
  //   2. fetchGroupCohortContext  → groupRow (AllowMidMonthEffective)
  // After these the validation throws, so no further queries fire.
  const query = jest.fn()
    .mockResolvedValueOnce({ recordset: memberRow ? [memberRow] : [] })
    .mockResolvedValueOnce({ recordset: groupRow ? [groupRow] : [] });
  return {
    request: () => ({ input: jest.fn().mockReturnThis(), query })
  };
}

const baseMember = {
  MemberId: 'm1',
  UserId: 'u1',
  HouseholdId: 'h1',
  GroupId: 'g1',
  AgentId: null,
  TenantId: 't1',
  BillType: 'GB',
  RelationshipType: 'P',
  Status: 'Active',
  DateOfBirth: '1980-01-01',
  TobaccoUse: 'N',
  Tier: null,
  State: 'TX',
  JobPosition: null,
  FirstName: 'Test',
  LastName: 'Member'
};

describe('planModification.buildPlan — cohort/flag validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects day-15 effectiveDate when group AllowMidMonthEffective=false and no cohort', async () => {
    getPool.mockResolvedValue(makePool({
      memberRow: baseMember,
      groupRow: { AllowMidMonthEffective: false }
    }));
    getHouseholdCohortByMemberId.mockResolvedValue(null);

    await expect(planMod.buildPlan({
      memberId: 'm1',
      tenantId: 't1',
      effectiveDate: '2026-06-15'
    })).rejects.toThrow(/must fall on the 1st\b/);
  });

  it('rejects day-1 effectiveDate when household cohort = FIFTEENTH', async () => {
    getPool.mockResolvedValue(makePool({
      memberRow: baseMember,
      groupRow: { AllowMidMonthEffective: true }
    }));
    getHouseholdCohortByMemberId.mockResolvedValue('FIFTEENTH');

    await expect(planMod.buildPlan({
      memberId: 'm1',
      tenantId: 't1',
      effectiveDate: '2026-06-01'
    })).rejects.toThrow(/locked to 15th cohort/);
  });

  it('rejects per-row effectiveDateEdits with mismatched cohort day', async () => {
    getPool.mockResolvedValue(makePool({
      memberRow: baseMember,
      groupRow: { AllowMidMonthEffective: true }
    }));
    getHouseholdCohortByMemberId.mockResolvedValue('FIFTEENTH');

    await expect(planMod.buildPlan({
      memberId: 'm1',
      tenantId: 't1',
      effectiveDate: '2026-06-15',
      effectiveDateEdits: [{ enrollmentId: 'e1', newEffectiveDate: '2026-07-01' }]
    })).rejects.toThrow(/effectiveDateEdits\[e1\].*locked to 15th cohort/);
  });

  it('passes validation for day-1 when no cohort and AllowMidMonthEffective=false (then fails downstream, not on date)', async () => {
    // Validation is silent on a valid date; subsequent code runs and may throw on
    // unrelated reasons (we only assert the thrown message is NOT a date-validation message).
    getPool.mockResolvedValue({
      request: () => ({
        input: jest.fn().mockReturnThis(),
        query: jest.fn()
          .mockResolvedValueOnce({ recordset: [baseMember] })
          .mockResolvedValueOnce({ recordset: [{ AllowMidMonthEffective: false }] })
          // any further calls return empty so downstream may throw on its own
          .mockResolvedValue({ recordset: [] })
      })
    });
    getHouseholdCohortByMemberId.mockResolvedValue(null);

    let thrown;
    try {
      await planMod.buildPlan({
        memberId: 'm1',
        tenantId: 't1',
        effectiveDate: '2026-06-01'
      });
    } catch (e) {
      thrown = e;
    }
    if (thrown) {
      expect(thrown.message).not.toMatch(/must fall on/);
    }
  });

  it('skips validation entirely for individual members (no GroupId)', async () => {
    const indMember = { ...baseMember, GroupId: null, BillType: 'IB' };
    getPool.mockResolvedValue({
      request: () => ({
        input: jest.fn().mockReturnThis(),
        query: jest.fn()
          .mockResolvedValueOnce({ recordset: [indMember] })
          .mockResolvedValue({ recordset: [] })
      })
    });

    let thrown;
    try {
      await planMod.buildPlan({
        memberId: 'm1',
        tenantId: 't1',
        effectiveDate: '2026-06-17' // mid-month, would be rejected for group members
      });
    } catch (e) {
      thrown = e;
    }
    if (thrown) {
      expect(thrown.message).not.toMatch(/must fall on/);
    }
    expect(getHouseholdCohortByMemberId).not.toHaveBeenCalled();
  });
});
