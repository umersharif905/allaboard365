'use strict';

jest.mock('../agentHierarchy', () => ({
    isUplineAncestor: jest.fn(),
    isAgencyAdmin: jest.fn()
}));

const { isUplineAncestor, isAgencyAdmin } = require('../agentHierarchy');
const {
    resolveLimitedEditPermissions,
    buildNoEditableFieldsMessage,
    getLimitedEditContext
} = require('../agentLimitedEdit');

describe('resolveLimitedEditPermissions', () => {
    test('upline-only can edit commission tier but not profile or status', () => {
        const result = resolveLimitedEditPermissions({
            isSelf: false,
            isUpline: true,
            isAgencyAdminOfTarget: false
        });

        expect(result.scopes).toEqual(['upline']);
        expect(result.editableFields).toEqual({
            profile: false,
            status: false,
            commissionTier: true
        });
        expect(result.allowedAgentFields.has('commissionLevelId')).toBe(true);
        expect(result.allowedUserFields.size).toBe(0);
    });

    test('agency admin who is also upline gets cumulative profile, status, and tier rights', () => {
        const result = resolveLimitedEditPermissions({
            isSelf: false,
            isUpline: true,
            isAgencyAdminOfTarget: true
        });

        expect(result.scopes).toEqual(['upline', 'agencyAdmin']);
        expect(result.editableFields).toEqual({
            profile: true,
            status: true,
            commissionTier: true
        });
        expect(result.allowedUserFields.has('email')).toBe(true);
        expect(result.allowedAgentFields.has('status')).toBe(true);
        expect(result.allowedAgentFields.has('commissionLevelId')).toBe(true);
    });

    test('self can edit profile but not status or tier via limited-edit', () => {
        const result = resolveLimitedEditPermissions({
            isSelf: true,
            isUpline: false,
            isAgencyAdminOfTarget: false
        });

        expect(result.scopes).toEqual(['self']);
        expect(result.editableFields).toEqual({
            profile: true,
            status: false,
            commissionTier: false
        });
    });
});

describe('buildNoEditableFieldsMessage', () => {
    test('describes upline-only permissions clearly', () => {
        const { allowedUserFields, allowedAgentFields } = resolveLimitedEditPermissions({
            isSelf: false,
            isUpline: true,
            isAgencyAdminOfTarget: false
        });

        expect(buildNoEditableFieldsMessage(allowedUserFields, allowedAgentFields))
            .toBe('Your role can only change commission tier for this agent.');
    });
});

describe('getLimitedEditContext', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('unions upline and agency admin flags independently', async () => {
        isUplineAncestor.mockResolvedValue(true);
        isAgencyAdmin.mockResolvedValue(true);

        const result = await getLimitedEditContext(
            {},
            'caller-agent-id',
            'target-agent-id',
            'agency-id'
        );

        expect(result.editableFields.profile).toBe(true);
        expect(result.editableFields.commissionTier).toBe(true);
        expect(result.scopes).toEqual(['upline', 'agencyAdmin']);
    });
});
