const VendorExportService = require('../vendorExportService');

describe('VendorExportService.expandMemberIdsToFullHouseholds', () => {
    it('returns empty array when no seed member IDs', async () => {
        const pool = { request: jest.fn() };
        await expect(VendorExportService.expandMemberIdsToFullHouseholds(pool, [])).resolves.toEqual([]);
        expect(pool.request).not.toHaveBeenCalled();
    });

    it('returns all distinct member IDs in seeded households', async () => {
        const primaryId = '11111111-1111-1111-1111-111111111111';
        const spouseId = '22222222-2222-2222-2222-222222222222';
        const childId = '33333333-3333-3333-3333-333333333333';
        const query = jest.fn().mockResolvedValue({
            recordset: [{ MemberId: primaryId }, { MemberId: spouseId }, { MemberId: childId }],
        });
        const pool = { request: jest.fn(() => ({ input: jest.fn().mockReturnThis(), query })) };

        const expanded = await VendorExportService.expandMemberIdsToFullHouseholds(pool, [primaryId]);

        expect(expanded).toEqual([primaryId, spouseId, childId]);
        expect(query).toHaveBeenCalledTimes(1);
        expect(String(query.mock.calls[0][0])).toContain('seed.HouseholdId = m.HouseholdId');
    });

    it('dedupes when multiple seeds share a household', async () => {
        const primaryId = '11111111-1111-1111-1111-111111111111';
        const spouseId = '22222222-2222-2222-2222-222222222222';
        const query = jest.fn().mockResolvedValue({
            recordset: [{ MemberId: primaryId }, { MemberId: spouseId }, { MemberId: primaryId }],
        });
        const pool = { request: jest.fn(() => ({ input: jest.fn().mockReturnThis(), query })) };

        const expanded = await VendorExportService.expandMemberIdsToFullHouseholds(pool, [primaryId, spouseId]);

        expect(expanded).toEqual([primaryId, spouseId]);
    });
});
