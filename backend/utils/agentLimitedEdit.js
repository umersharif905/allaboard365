/**
 * Limited-edit permission resolver for agent profile updates.
 * Scopes are cumulative: agency admin + upline unions apply together.
 */

const { isUplineAncestor, isAgencyAdmin } = require('./agentHierarchy');

function resolveLimitedEditPermissions({ isSelf, isUpline, isAgencyAdminOfTarget }) {
    const allowedUserFields = new Set();
    const allowedAgentFields = new Set();
    const scopes = [];

    if (isSelf) scopes.push('self');
    if (isUpline) scopes.push('upline');
    if (isAgencyAdminOfTarget) scopes.push('agencyAdmin');

    if (!isSelf && !isUpline && !isAgencyAdminOfTarget) {
        return {
            scopes,
            allowedUserFields,
            allowedAgentFields,
            editableFields: { profile: false, status: false, commissionTier: false }
        };
    }

    if (isSelf || isAgencyAdminOfTarget) {
        ['firstName', 'lastName', 'email', 'phoneNumber'].forEach((k) => allowedUserFields.add(k));
    }
    if (isAgencyAdminOfTarget) {
        allowedAgentFields.add('status');
    }
    if (isAgencyAdminOfTarget || isUpline) {
        allowedAgentFields.add('commissionLevelId');
    }

    return {
        scopes,
        allowedUserFields,
        allowedAgentFields,
        editableFields: {
            profile: allowedUserFields.size > 0,
            status: allowedAgentFields.has('status'),
            commissionTier: allowedAgentFields.has('commissionLevelId')
        }
    };
}

function buildNoEditableFieldsMessage(allowedUserFields, allowedAgentFields) {
    const canEdit = [];
    if (allowedAgentFields.has('commissionLevelId')) canEdit.push('commission tier');
    if (allowedAgentFields.has('status')) canEdit.push('status');
    if (allowedUserFields.size > 0) canEdit.push('profile fields');

    if (canEdit.length === 0) {
        return 'Not authorized to edit any fields for this agent.';
    }
    return `Your role can only change ${canEdit.join(' and ')} for this agent.`;
}

async function getLimitedEditContext(pool, callerAgentId, targetAgentId, targetAgencyId) {
    const isSelf = String(targetAgentId).toLowerCase() === String(callerAgentId).toLowerCase();
    const isUpline = !isSelf && await isUplineAncestor(pool, targetAgentId, callerAgentId);
    const isAgencyAdminOfTarget = !!targetAgencyId
        && await isAgencyAdmin(pool, callerAgentId, targetAgencyId);
    return resolveLimitedEditPermissions({ isSelf, isUpline, isAgencyAdminOfTarget });
}

module.exports = {
    resolveLimitedEditPermissions,
    buildNoEditableFieldsMessage,
    getLimitedEditContext
};
