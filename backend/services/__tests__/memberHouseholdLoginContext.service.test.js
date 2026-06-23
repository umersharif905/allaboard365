jest.mock('../../config/database');

const mockRequest = { input: jest.fn().mockReturnThis(), query: jest.fn() };
const mockPool = { request: jest.fn().mockReturnValue(mockRequest) };
const db = require('../../config/database');
db.getPool = jest.fn().mockResolvedValue(mockPool);

const {
  resolveMemberHouseholdLoginContext,
  getLoginMetadataForUser,
  SPOUSE_DELEGATION_DENIED,
} = require('../memberHouseholdLoginContext.service');

const ACTOR_USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PRIMARY_USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ACTOR_MEMBER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PRIMARY_MEMBER = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const HOUSEHOLD = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

describe('resolveMemberHouseholdLoginContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('primary actor: effective equals actor', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        ActorMemberId: ACTOR_MEMBER,
        ActorUserId: ACTOR_USER,
        HouseholdId: HOUSEHOLD,
        ActorRelationshipType: 'P',
        ActorGroupId: null,
        ActorTenantId: 'tenant-1',
        ActorHouseholdMemberId: 'MW1',
        ActorMemberStatus: 'Active',
      }],
    });

    const ctx = await resolveMemberHouseholdLoginContext(ACTOR_USER, { delegateSpouse: true });
    expect(ctx.effectiveUserId).toBe(ACTOR_USER);
    expect(ctx.effectiveMemberId).toBe(ACTOR_MEMBER);
    expect(ctx.isSpouseDelegate).toBe(false);
    expect(mockRequest.query).toHaveBeenCalledTimes(1);
  });

  test('spouse actor with eligible primary: delegates to primary', async () => {
    mockRequest.query
      .mockResolvedValueOnce({
        recordset: [{
          ActorMemberId: 'spouse-member',
          ActorUserId: ACTOR_USER,
          HouseholdId: HOUSEHOLD,
          ActorRelationshipType: 'S',
          ActorGroupId: null,
          ActorTenantId: 'tenant-1',
          ActorHouseholdMemberId: 'MW2',
          ActorMemberStatus: 'Active',
        }],
      })
      .mockResolvedValueOnce({
        recordset: [{
          PrimaryMemberId: PRIMARY_MEMBER,
          PrimaryUserId: PRIMARY_USER,
          PrimaryHouseholdMemberId: 'MW1',
        }],
      })
      .mockResolvedValueOnce({
        recordset: [{ HouseholdMemberID: 'MW1' }],
      });

    const ctx = await resolveMemberHouseholdLoginContext(ACTOR_USER, { delegateSpouse: true });
    expect(ctx.isSpouseDelegate).toBe(true);
    expect(ctx.effectiveMemberId).toBe(PRIMARY_MEMBER);
    expect(ctx.effectiveUserId).toBe(PRIMARY_USER);
    expect(ctx.primaryMemberId).toBe(PRIMARY_MEMBER);
  });

  test('spouse without eligible primary: 403', async () => {
    mockRequest.query
      .mockResolvedValueOnce({
        recordset: [{
          ActorMemberId: 'spouse-member',
          ActorUserId: ACTOR_USER,
          HouseholdId: HOUSEHOLD,
          ActorRelationshipType: 'S',
          ActorGroupId: null,
          ActorTenantId: 'tenant-1',
          ActorHouseholdMemberId: 'MW2',
          ActorMemberStatus: 'Active',
        }],
      })
      .mockResolvedValueOnce({ recordset: [] });

    await expect(
      resolveMemberHouseholdLoginContext(ACTOR_USER, { delegateSpouse: true })
    ).rejects.toMatchObject({ status: 403, code: 'SPOUSE_DELEGATION_DENIED', message: SPOUSE_DELEGATION_DENIED });
  });

  test('no member row: 404', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });
    await expect(
      resolveMemberHouseholdLoginContext(ACTOR_USER)
    ).rejects.toMatchObject({ status: 404, code: 'MEMBER_NOT_FOUND' });
  });

  test('getLoginMetadataForUser without member row returns empty metadata', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });
    const meta = await getLoginMetadataForUser(ACTOR_USER);
    expect(meta.memberId).toBeUndefined();
    expect(meta.householdMemberId).toBeUndefined();
    expect(meta.isSpouseDelegate).toBe(false);
  });

  test('child actor without delegation: effective stays actor', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        ActorMemberId: 'child-member',
        ActorUserId: ACTOR_USER,
        HouseholdId: HOUSEHOLD,
        ActorRelationshipType: 'C',
        ActorGroupId: null,
        ActorTenantId: 'tenant-1',
        ActorHouseholdMemberId: 'MW3',
        ActorMemberStatus: 'Active',
      }],
    });

    const ctx = await resolveMemberHouseholdLoginContext(ACTOR_USER, { delegateSpouse: true });
    expect(ctx.isSpouseDelegate).toBe(false);
    expect(ctx.effectiveMemberId).toBe('child-member');
    expect(mockRequest.query).toHaveBeenCalledTimes(1);
  });
});
