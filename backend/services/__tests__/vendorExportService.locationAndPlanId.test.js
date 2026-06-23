/**
 * Tests for vendorExportService:
 *  - enrichLocationNumbers: populates Location Number when conditions met
 *  - armColumnOrder: includes 'Plan ID' appended at end
 *  - formatAsCSV: excludes _PrimaryLocationId from output headers
 */

const VendorExportService = require('../vendorExportService');
const sql = require('mssql');

const VENDOR_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GROUP_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LOC_ID_1  = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const LOC_ID_2  = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// ----------------------------------------------------------------
// armColumnOrder includes 'Plan ID'
// ----------------------------------------------------------------
describe('VendorExportService.formatAsCSV — armColumnOrder includes Plan ID', () => {
    test('Plan ID appears in CSV output columns when present in data', () => {
        const data = [{
            'Group Number': 'MW1001',
            'Location Number': '',
            'Plan ID': 'PLAN-A',
            'Last Name': 'Smith',
            'First Name': 'John',
        }];
        const csv = VendorExportService.formatAsCSV(data);
        expect(csv).toContain('Plan ID');
        expect(csv).toContain('PLAN-A');
    });

    test('_PrimaryLocationId is excluded from CSV headers', () => {
        const data = [{
            'Group Number': 'MW1001',
            'Location Number': 'MW1001',
            '_PrimaryLocationId': LOC_ID_1,
            'Last Name': 'Smith',
        }];
        const csv = VendorExportService.formatAsCSV(data);
        expect(csv).not.toContain('_PrimaryLocationId');
        expect(csv).toContain('Location Number');
    });

    test('AC2: Plan ID column is present even when Products.PlanId is null/empty string', () => {
        // ISNULL(p.PlanId,'') returns '' when PlanId is NULL — column header must still appear
        const data = [{
            'Group Number': 'MW1001',
            'Location Number': '',
            'Plan ID': '',
            'Last Name': 'Doe',
            'First Name': 'Jane',
        }];
        const csv = VendorExportService.formatAsCSV(data);
        // AC2: column header must still appear (not omitted when blank)
        expect(csv).toContain('Plan ID');
        // At least header + 1 data row
        expect(csv.split('\n').length).toBeGreaterThan(1);
    });

    test('AC11: Group Number column is present and unchanged in CSV output', () => {
        const data = [{
            'Group Number': 'MW5050',
            'Location Number': '',
            'Plan ID': '',
            'Last Name': 'Smith',
        }];
        const csv = VendorExportService.formatAsCSV(data);
        // AC11: "Group Number behavior unchanged" — column must exist and carry the value
        expect(csv).toContain('Group Number');
        expect(csv).toContain('MW5050');
        // Column must NOT have been renamed
        expect(csv).not.toContain('Group ID,');
        expect(csv).not.toContain('GroupNumber,');
    });
});

// ----------------------------------------------------------------
// enrichLocationNumbers
// ----------------------------------------------------------------
describe('VendorExportService.enrichLocationNumbers', () => {
    function makePool(calls) {
        let i = 0;
        return {
            request: jest.fn(() => ({
                input: jest.fn().mockReturnThis(),
                query: jest.fn().mockImplementation(() =>
                    Promise.resolve(calls[i++] || { recordset: [] })
                ),
            })),
        };
    }

    test('does nothing when records array is empty', async () => {
        const pool = makePool([]);
        await expect(
            VendorExportService.enrichLocationNumbers([], VENDOR_ID, pool)
        ).resolves.toBeUndefined();
    });

    test('does nothing when no records have _PrimaryLocationId', async () => {
        const records = [{ _GroupIdForBillType: GROUP_ID, _PrimaryLocationId: null, 'Location Number': '' }];
        const pool = makePool([]);
        await VendorExportService.enrichLocationNumbers(records, VENDOR_ID, pool);
        expect(records[0]['Location Number']).toBe('');
    });

    test('does not populate when group has fewer than 2 active locations', async () => {
        const records = [{ _GroupIdForBillType: GROUP_ID, _PrimaryLocationId: LOC_ID_1, 'Location Number': '' }];
        // locCount = 1 < 2 → skip
        const pool = makePool([{ recordset: [{ cnt: 1 }] }]);
        await VendorExportService.enrichLocationNumbers(records, VENDOR_ID, pool);
        expect(records[0]['Location Number']).toBe('');
    });

    test('does not populate when setting is disabled', async () => {
        const records = [{ _GroupIdForBillType: GROUP_ID, _PrimaryLocationId: LOC_ID_1, 'Location Number': '' }];
        const pool = makePool([
            { recordset: [{ cnt: 2 }] },          // locCount ≥ 2
            { recordset: [{ LocationVendorGroupIdsEnabled: false }] }, // setting disabled
        ]);
        await VendorExportService.enrichLocationNumbers(records, VENDOR_ID, pool);
        expect(records[0]['Location Number']).toBe('');
    });

    test('populates Location Number with exact VendorLocationId when all conditions met — AC10', async () => {
        const records = [
            { _GroupIdForBillType: GROUP_ID, _PrimaryLocationId: LOC_ID_1, 'Location Number': '' },
            { _GroupIdForBillType: GROUP_ID, _PrimaryLocationId: LOC_ID_2, 'Location Number': '' },
        ];
        const pool = makePool([
            { recordset: [{ cnt: 2 }] },                              // locCount ≥ 2
            { recordset: [{ LocationVendorGroupIdsEnabled: true }] },  // setting enabled
            // batch fetch of VendorLocationIds
            { recordset: [
                { LocationId: LOC_ID_1, VendorLocationId: 'MW1000' },
                { LocationId: LOC_ID_2, VendorLocationId: 'MW1001' },
            ]},
        ]);
        await VendorExportService.enrichLocationNumbers(records, VENDOR_ID, pool);

        // AC10: each record's Location Number must match the exact VendorLocationId for its location
        const rec1 = records.find(r => r._PrimaryLocationId === LOC_ID_1);
        const rec2 = records.find(r => r._PrimaryLocationId === LOC_ID_2);
        expect(rec1['Location Number']).toBe('MW1000');
        expect(rec2['Location Number']).toBe('MW1001');
    });

    test('does not overwrite already-set Location Number', async () => {
        const records = [{ _GroupIdForBillType: GROUP_ID, _PrimaryLocationId: LOC_ID_1, 'Location Number': 'EXISTING' }];
        const pool = makePool([
            { recordset: [{ cnt: 2 }] },
            { recordset: [{ LocationVendorGroupIdsEnabled: true }] },
            { recordset: [{ LocationId: LOC_ID_1, VendorLocationId: 'MW1000' }] },
        ]);
        await VendorExportService.enrichLocationNumbers(records, VENDOR_ID, pool);
        expect(records[0]['Location Number']).toBe('EXISTING');
    });
});
