'use strict';

const {
  resolveMemberHouseholdLoginContext,
  SPOUSE_DELEGATION_DENIED,
} = require('../services/memberHouseholdLoginContext.service');

function shouldSkipSpouseDelegation(req) {
  const url = req.originalUrl || req.url || '';
  return /\/member\/forms(\/|$)/.test(url);
}

function isMemberSession(req) {
  const role = req.user?.currentRole;
  if (role) return role === 'Member';
  const roles = req.user?.roles;
  if (Array.isArray(roles) && roles.length === 1) return roles[0] === 'Member';
  if (Array.isArray(roles)) return roles.includes('Member') && !roles.some((r) =>
    ['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin'].includes(r)
  );
  return false;
}

function getMemberContext(req) {
  return req.memberContext || null;
}

function getActorUserId(req) {
  return req.memberContext?.actorUserId || req.user?.UserId || req.user?.userId;
}

function getActorMemberId(req) {
  return req.memberContext?.actorMemberId || null;
}

function getEffectiveUserId(req) {
  return req.memberContext?.effectiveUserId || req.user?.UserId || req.user?.userId;
}

function getEffectiveMemberId(req) {
  return req.memberContext?.effectiveMemberId || null;
}

function getHouseholdId(req) {
  return req.memberContext?.householdId || null;
}

function isSpouseDelegate(req) {
  return Boolean(req.memberContext?.isSpouseDelegate);
}

async function attachMemberHouseholdContext(req, res, next) {
  try {
    const userId = req.user?.UserId || req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const delegateSpouse = isMemberSession(req) && !shouldSkipSpouseDelegation(req);
    const ctx = await resolveMemberHouseholdLoginContext(userId, { delegateSpouse });
    req.memberContext = ctx;
    return next();
  } catch (err) {
    if (err.code === 'MEMBER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: err.message });
    }
    if (err.code === 'SPOUSE_DELEGATION_DENIED') {
      return res.status(403).json({ success: false, message: SPOUSE_DELEGATION_DENIED });
    }
    console.error('[attachMemberHouseholdContext]', err);
    return res.status(500).json({ success: false, message: 'Failed to resolve member context' });
  }
}

module.exports = {
  attachMemberHouseholdContext,
  getMemberContext,
  getActorUserId,
  getActorMemberId,
  getEffectiveUserId,
  getEffectiveMemberId,
  getHouseholdId,
  isSpouseDelegate,
};
