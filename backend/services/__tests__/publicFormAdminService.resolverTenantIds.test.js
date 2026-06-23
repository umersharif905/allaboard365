/**
 * updateTemplateMeta — ResolverTenantIds allow-list (the form-editor field that
 * lets a vendor-wide form resolve members across sibling tenants). Validates
 * storage + input validation without a live DB.
 */

let mockLastQuery = null;
let mockLastInputs = null;
let mockNextRecordset = [];

jest.mock('../../config/database', () => {
    function makeRequest() {
        const inputs = {};
        const req = {
            input(name, _type, value) {
                inputs[name] = arguments.length === 2 ? _type : value;
                return req;
            },
            async query(text) {
                mockLastQuery = text;
                mockLastInputs = inputs;
                return { recordset: mockNextRecordset };
            }
        };
        return req;
    }
    const NVarChar = (n) => ({ t: 'NVarChar', n });
    NVarChar.MAX = 'MAX';
    return {
        getPool: async () => ({ request: () => makeRequest() }),
        sql: { UniqueIdentifier: 'UniqueIdentifier', NVarChar, Bit: 'Bit', Int: 'Int', MAX: 'MAX' }
    };
});

const { updateTemplateMeta } = require('../publicFormAdminService');

const TENANT = 'AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA';
const FORM = 'BBBBBBBB-2222-4222-8222-BBBBBBBBBBBB';
const TID1 = 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6';
const TID2 = '14D52554-C676-4C25-B25A-B9A004B29D1A';

beforeEach(() => {
    mockLastQuery = null;
    mockLastInputs = null;
    mockNextRecordset = [{ FormTemplateId: FORM }]; // template-exists check passes
});

describe('updateTemplateMeta — resolverTenantIds', () => {
    it('stores a JSON array of GUIDs', async () => {
        await updateTemplateMeta(TENANT, FORM, { resolverTenantIds: [TID1, TID2] });
        expect(mockLastQuery).toMatch(/ResolverTenantIds = @resolverTenantIds/);
        expect(JSON.parse(mockLastInputs.resolverTenantIds)).toEqual([TID1, TID2]);
    });

    it('de-dupes exact duplicates', async () => {
        await updateTemplateMeta(TENANT, FORM, { resolverTenantIds: [TID1, TID1, TID2] });
        expect(JSON.parse(mockLastInputs.resolverTenantIds)).toEqual([TID1, TID2]);
    });

    it('empty array stores NULL (own-tenant-only)', async () => {
        await updateTemplateMeta(TENANT, FORM, { resolverTenantIds: [] });
        expect(mockLastInputs.resolverTenantIds).toBeNull();
    });

    it('null stores NULL', async () => {
        await updateTemplateMeta(TENANT, FORM, { resolverTenantIds: null });
        expect(mockLastInputs.resolverTenantIds).toBeNull();
    });

    it('rejects an invalid GUID', async () => {
        await expect(
            updateTemplateMeta(TENANT, FORM, { resolverTenantIds: ['not-a-guid'] })
        ).rejects.toThrow(/invalid GUID/i);
    });

    it('rejects a non-array value', async () => {
        await expect(
            updateTemplateMeta(TENANT, FORM, { resolverTenantIds: 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6' })
        ).rejects.toThrow(/must be an array/i);
    });
});
