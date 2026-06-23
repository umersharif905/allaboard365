'use strict';

const { getPool, sql } = require('../config/database');
const { HAS_LOGIN_ELIGIBLE_ENROLLMENT_SQL } = require('../utils/memberEnrollmentStatusSql');

const SPOUSE_DELEGATION_DENIED =
  'Household billing and plans are only available when the primary member account is active. Please contact support.';

/**
 * Resolve actor member row and optional spouse → primary delegation.
 * @param {string} userId - JWT UserId (actor)
 * @param {{ delegateSpouse?: boolean }} [options]
 *   delegateSpouse: when true and actor is S with Member intent, require eligible primary and set effective* to primary.
 */
async function resolveMemberHouseholdLoginContext(userId, options = {}) {
  const { delegateSpouse = true } = options;
  const pool = await getPool();

  const actorResult = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1
        m.MemberId AS ActorMemberId,
        m.UserId AS ActorUserId,
        m.HouseholdId,
        m.RelationshipType AS ActorRelationshipType,
        m.GroupId AS ActorGroupId,
        m.TenantId AS ActorTenantId,
        m.HouseholdMemberID AS ActorHouseholdMemberId,
        m.Status AS ActorMemberStatus
      FROM oe.Members m
      WHERE m.UserId = @userId
        AND (m.Status IS NULL OR m.Status != 'Terminated')
      ORDER BY
        CASE WHEN m.RelationshipType = 'P' THEN 0 ELSE 1 END,
        m.MemberSequence ASC,
        m.CreatedDate ASC
    `);

  const actor = actorResult.recordset[0];
  if (!actor) {
    const err = new Error('Member record not found for this account.');
    err.status = 404;
    err.code = 'MEMBER_NOT_FOUND';
    throw err;
  }

  const actorRelationshipType = actor.ActorRelationshipType || null;
  const isSpouseActor = actorRelationshipType === 'S';
  const isPrimaryActor = actorRelationshipType === 'P';

  let effectiveUserId = actor.ActorUserId;
  let effectiveMemberId = actor.ActorMemberId;
  let primaryMemberId = isPrimaryActor ? actor.ActorMemberId : null;
  let primaryUserId = isPrimaryActor ? actor.ActorUserId : null;
  let isSpouseDelegate = false;

  if (delegateSpouse && isSpouseActor && !isPrimaryActor) {
    const primaryResult = await pool.request()
      .input('householdId', sql.UniqueIdentifier, actor.HouseholdId)
      .query(`
        SELECT TOP 1
          m.MemberId AS PrimaryMemberId,
          m.UserId AS PrimaryUserId,
          m.HouseholdMemberID AS PrimaryHouseholdMemberId
        FROM oe.Members m
        WHERE m.HouseholdId = @householdId
          AND m.RelationshipType = 'P'
          AND (m.Status IS NULL OR m.Status != 'Terminated')
          AND ${HAS_LOGIN_ELIGIBLE_ENROLLMENT_SQL}
        ORDER BY m.MemberSequence ASC, m.CreatedDate ASC
      `);

    const primary = primaryResult.recordset[0];
    if (!primary?.PrimaryMemberId) {
      const err = new Error(SPOUSE_DELEGATION_DENIED);
      err.status = 403;
      err.code = 'SPOUSE_DELEGATION_DENIED';
      throw err;
    }

    effectiveMemberId = primary.PrimaryMemberId;
    effectiveUserId = primary.PrimaryUserId || actor.ActorUserId;
    primaryMemberId = primary.PrimaryMemberId;
    primaryUserId = primary.PrimaryUserId;
    isSpouseDelegate = true;
  }

  return {
    actorUserId: actor.ActorUserId,
    actorMemberId: actor.ActorMemberId,
    actorRelationshipType,
    actorHouseholdMemberId: actor.ActorHouseholdMemberId,
    actorGroupId: actor.ActorGroupId,
    actorTenantId: actor.ActorTenantId,
    effectiveUserId,
    effectiveMemberId,
    householdId: actor.HouseholdId,
    isSpouseDelegate,
    primaryMemberId: primaryMemberId || (isPrimaryActor ? actor.ActorMemberId : null),
    primaryUserId: primaryUserId || (isPrimaryActor ? actor.ActorUserId : null),
    primaryHouseholdMemberId: isSpouseDelegate
      ? (await getHouseholdMemberIdForMember(pool, effectiveMemberId))
      : actor.ActorHouseholdMemberId,
  };
}

async function getHouseholdMemberIdForMember(pool, memberId) {
  const r = await pool.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .query(`SELECT HouseholdMemberID FROM oe.Members WHERE MemberId = @memberId`);
  return r.recordset[0]?.HouseholdMemberID || null;
}

/**
 * Login response metadata: household primary member ids when actor is spouse.
 * Returns empty fields when the user has no member row (agents, tenant admins, etc.).
 */
async function getLoginMetadataForUser(userId) {
  let ctx;
  try {
    ctx = await resolveMemberHouseholdLoginContext(userId, { delegateSpouse: false });
  } catch (err) {
    if (err.code === 'MEMBER_NOT_FOUND') {
      return {
        memberId: undefined,
        householdMemberId: undefined,
        isSpouseDelegate: false,
      };
    }
    throw err;
  }
  if (ctx.actorRelationshipType !== 'S') {
    return {
      memberId: ctx.effectiveMemberId ? String(ctx.effectiveMemberId) : undefined,
      householdMemberId: ctx.actorHouseholdMemberId || undefined,
      isSpouseDelegate: false,
    };
  }
  try {
    const delegated = await resolveMemberHouseholdLoginContext(userId, { delegateSpouse: true });
    return {
      memberId: delegated.effectiveMemberId ? String(delegated.effectiveMemberId) : undefined,
      householdMemberId: delegated.primaryHouseholdMemberId || delegated.actorHouseholdMemberId || undefined,
      isSpouseDelegate: true,
    };
  } catch {
    return {
      memberId: ctx.actorMemberId ? String(ctx.actorMemberId) : undefined,
      householdMemberId: ctx.actorHouseholdMemberId || undefined,
      isSpouseDelegate: false,
    };
  }
}

module.exports = {
  SPOUSE_DELEGATION_DENIED,
  resolveMemberHouseholdLoginContext,
  getLoginMetadataForUser,
};
