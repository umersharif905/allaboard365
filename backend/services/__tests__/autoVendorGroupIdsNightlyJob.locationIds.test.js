/**
 * Tests for autoVendorGroupIdsNightlyJob.service.js — location ID extension.
 * The job uses vendorServedGroupsService helpers and inline pool queries
 * for the GroupVendorLocationIdSettings check.
 */

const VENDOR_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GROUP_ID_1 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GROUP_ID_2 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SYSTEM_UID = 'A0000001-0000-4000-8000-000000000001';

// ---- DB pool mock ----
let poolQueryResponses = [];
let poolQueryCallIndex  = 0;
const mockPoolInput  = jest.fn().mockReturnThis();
const mockPoolQuery  = jest.fn().mockImplementation(() => {
    const r = poolQueryResponses[poolQueryCallIndex++] || { recordset: [] };
    return Promise.resolve(r);
});
const mockPoolRequest = jest.fn(() => ({ input: mockPoolInput, query: mockPoolQuery }));
const mockPool = { request: mockPoolRequest };

jest.mock('../../config/database', () => ({
    getPool: jest.fn().mockResolvedValue(mockPool),
    sql: {
        UniqueIdentifier: 'UniqueIdentifier',
        NVarChar: jest.fn((n) => `NVarChar(${n})`),
        Int: 'Int',
        Bit: 'Bit',
    },
}));
jest.mock('mssql', () => ({
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: jest.fn((n) => `NVarChar(${n})`),
    Int: 'Int',
    Bit: 'Bit',
}));

// ---- Service mocks ----
jest.mock('../../services/vendorGroupIdService');
jest.mock('../../services/vendorExportService', () => ({
    recordScheduledJobRun: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/vendorServedGroupsService', () => ({
    loadVendorIdsApplicable: jest.fn(),
    getServedGroupIdsForVendor: jest.fn(),
}));

const VendorGroupIdService  = require('../../services/vendorGroupIdService');
const VendorExportService   = require('../../services/vendorExportService');
const { loadVendorIdsApplicable, getServedGroupIdsForVendor } = require('../../services/vendorServedGroupsService');

function setPoolResponses(...responses) {
    poolQueryCallIndex = 0;
    poolQueryResponses = responses;
}

let runAutoVendorGroupIdsJob;
beforeAll(() => {
    ({ runAutoVendorGroupIdsJob } = require('../../services/autoVendorGroupIdsNightlyJob.service'));
});

beforeEach(() => {
    jest.clearAllMocks();
    poolQueryCallIndex = 0;
    poolQueryResponses = [];
});

// ----------------------------------------------------------------
describe('autoVendorGroupIdsNightlyJob — location ID generation', () => {

    test('calls generateLocationVendorGroupIds for groups with setting enabled', async () => {
        // Pool query: listOptedInVendors
        setPoolResponses(
            { recordset: [{ VendorId: VENDOR_ID, VendorName: 'Test Vendor' }] },
            // Per-group setting checks (one per group in allGroupIds)
            { recordset: [{ LocationVendorGroupIdsEnabled: true }] },
            { recordset: [{ LocationVendorGroupIdsEnabled: true }] },
        );

        loadVendorIdsApplicable.mockResolvedValue(true);
        // missingMasterOnly: true → returns empty (no master IDs to create)
        getServedGroupIdsForVendor
            .mockResolvedValueOnce([])                        // master IDs pass
            .mockResolvedValueOnce([GROUP_ID_1, GROUP_ID_2]); // all groups pass

        VendorGroupIdService.generateLocationVendorGroupIds
            .mockResolvedValueOnce({ success: true, created: 1, errors: [] })
            .mockResolvedValueOnce({ success: true, created: 2, errors: [] });

        await runAutoVendorGroupIdsJob();

        expect(VendorGroupIdService.generateLocationVendorGroupIds).toHaveBeenCalledTimes(2);
        expect(VendorGroupIdService.generateLocationVendorGroupIds).toHaveBeenCalledWith(
            GROUP_ID_1, VENDOR_ID, SYSTEM_UID
        );
        expect(VendorGroupIdService.generateLocationVendorGroupIds).toHaveBeenCalledWith(
            GROUP_ID_2, VENDOR_ID, SYSTEM_UID
        );
    });

    test('skips location generation when setting is disabled for a group', async () => {
        setPoolResponses(
            { recordset: [{ VendorId: VENDOR_ID, VendorName: 'Test Vendor' }] },
            // Group 1: disabled, Group 2: disabled
            { recordset: [{ LocationVendorGroupIdsEnabled: false }] },
            { recordset: [] }, // no row = also disabled
        );

        loadVendorIdsApplicable.mockResolvedValue(true);
        getServedGroupIdsForVendor
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([GROUP_ID_1, GROUP_ID_2]);

        await runAutoVendorGroupIdsJob();

        expect(VendorGroupIdService.generateLocationVendorGroupIds).not.toHaveBeenCalled();
    });

    test('totalLocationIdsCreated is aggregated in job results', async () => {
        setPoolResponses(
            { recordset: [{ VendorId: VENDOR_ID, VendorName: 'Test Vendor' }] },
            { recordset: [{ LocationVendorGroupIdsEnabled: true }] },
        );

        loadVendorIdsApplicable.mockResolvedValue(true);
        getServedGroupIdsForVendor
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([GROUP_ID_1]);

        VendorGroupIdService.generateLocationVendorGroupIds
            .mockResolvedValueOnce({ success: true, created: 4, errors: [] });

        await runAutoVendorGroupIdsJob();

        // recordScheduledJobRun should have been called with methods including locationIdsCreated
        expect(VendorExportService.recordScheduledJobRun).toHaveBeenCalled();
        const callArgs = VendorExportService.recordScheduledJobRun.mock.calls[0];
        const opts = callArgs[0];
        const method = opts.result.methods[0];
        expect(method).toHaveProperty('locationIdsCreated');
    });

    test('skips vendor entirely when loadVendorIdsApplicable returns false', async () => {
        setPoolResponses(
            { recordset: [{ VendorId: VENDOR_ID, VendorName: 'Test Vendor' }] },
        );

        loadVendorIdsApplicable.mockResolvedValue(false);

        await runAutoVendorGroupIdsJob();

        expect(VendorGroupIdService.generateLocationVendorGroupIds).not.toHaveBeenCalled();
    });

    test('handles generateLocationVendorGroupIds error gracefully', async () => {
        setPoolResponses(
            { recordset: [{ VendorId: VENDOR_ID, VendorName: 'Test Vendor' }] },
            { recordset: [{ LocationVendorGroupIdsEnabled: true }] },
        );

        loadVendorIdsApplicable.mockResolvedValue(true);
        getServedGroupIdsForVendor
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([GROUP_ID_1]);

        VendorGroupIdService.generateLocationVendorGroupIds
            .mockRejectedValueOnce(new Error('DB timeout'));

        await expect(runAutoVendorGroupIdsJob()).resolves.not.toThrow();
    });
});
