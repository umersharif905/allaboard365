const {
    isValidGuid,
    resolveTenantProductSubscriptionId,
    ensureOwnerTenantProductSubscription,
    ensureTenantProductSubscription
} = require('../tenantProductSubscriptionEnsure');

describe('tenantProductSubscriptionEnsure', () => {
    describe('isValidGuid', () => {
        test('accepts canonical GUID', () => {
            expect(isValidGuid('AE8A82A9-632D-4655-AEDA-7CB563D3A8C6')).toBe(true);
        });

        test('rejects undefined string and empty', () => {
            expect(isValidGuid('undefined')).toBe(false);
            expect(isValidGuid('')).toBe(false);
            expect(isValidGuid(undefined)).toBe(false);
        });
    });

    describe('resolveTenantProductSubscriptionId', () => {
        const tenantId = 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6';
        const subscriptionId = '11111111-1111-1111-1111-111111111111';
        const productId = '22222222-2222-2222-2222-222222222222';

        function makePool(handlers) {
            let call = 0;
            return {
                request() {
                    const idx = call++;
                    const handler = handlers[idx];
                    return {
                        input() { return this; },
                        async query() {
                            return handler ? handler() : { recordset: [] };
                        }
                    };
                }
            };
        }

        test('returns existing subscription when param matches SubscriptionId', async () => {
            const pool = makePool([
                () => ({ recordset: [{ SubscriptionId: subscriptionId }] })
            ]);
            const result = await resolveTenantProductSubscriptionId(
                pool,
                { UniqueIdentifier: 'guid' },
                tenantId,
                'user-id',
                subscriptionId
            );
            expect(result).toEqual({ ok: true, subscriptionId });
        });

        test('returns 404 when param is not a subscription and product is not owned', async () => {
            const pool = makePool([
                () => ({ recordset: [] }),
                () => ({ recordset: [] })
            ]);
            const result = await resolveTenantProductSubscriptionId(
                pool,
                { UniqueIdentifier: 'guid' },
                tenantId,
                'user-id',
                productId
            );
            expect(result).toEqual({ ok: false, status: 404, message: 'Subscription not found' });
        });

        test('returns 400 for invalid param', async () => {
            const result = await resolveTenantProductSubscriptionId(
                makePool([]),
                {},
                tenantId,
                'user-id',
                'undefined'
            );
            expect(result).toEqual({
                ok: false,
                status: 400,
                message: 'Valid subscription or product id is required'
            });
        });
    });

    describe('ensureTenantProductSubscription', () => {
        const tenantId = 'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6';
        const productId = '22222222-2222-2222-2222-222222222222';

        test('returns existing active subscription without creating a new row', async () => {
            const pool = {
                request() {
                    return {
                        input() { return this; },
                        async query(sqlText) {
                            if (/FROM oe\.TenantProductSubscriptions/i.test(sqlText)) {
                                return { recordset: [{ SubscriptionId: '11111111-1111-1111-1111-111111111111', SubscriptionStatus: 'Active' }] };
                            }
                            if (/FROM oe\.ProductSubscriptions/i.test(sqlText)) {
                                return { recordset: [{ ProductSubscriptionId: '33333333-3333-3333-3333-333333333333', Status: 'Approved' }] };
                            }
                            return { recordset: [] };
                        }
                    };
                }
            };

            const result = await ensureTenantProductSubscription(pool, { UniqueIdentifier: 'guid' }, {
                tenantId,
                productId,
                userId: 'user-id'
            });

            expect(result).toEqual({
                ok: true,
                subscriptionId: '11111111-1111-1111-1111-111111111111',
                created: false,
                reactivated: false
            });
        });

        test('reactivates cancelled tenant subscription', async () => {
            let updateCalled = false;
            const pool = {
                request() {
                    return {
                        input() { return this; },
                        async query(sqlText) {
                            if (/FROM oe\.TenantProductSubscriptions/i.test(sqlText) && /SELECT TOP 1/i.test(sqlText)) {
                                return { recordset: [{ SubscriptionId: '11111111-1111-1111-1111-111111111111', SubscriptionStatus: 'Cancelled' }] };
                            }
                            if (/UPDATE oe\.TenantProductSubscriptions/i.test(sqlText)) {
                                updateCalled = true;
                                return { recordset: [] };
                            }
                            if (/FROM oe\.ProductSubscriptions/i.test(sqlText)) {
                                return { recordset: [{ ProductSubscriptionId: '33333333-3333-3333-3333-333333333333', Status: 'Approved' }] };
                            }
                            return { recordset: [] };
                        }
                    };
                }
            };

            const result = await ensureTenantProductSubscription(pool, { UniqueIdentifier: 'guid' }, {
                tenantId,
                productId,
                userId: 'user-id'
            });

            expect(updateCalled).toBe(true);
            expect(result.ok).toBe(true);
            expect(result.reactivated).toBe(true);
        });
    });

    describe('ensureOwnerTenantProductSubscription', () => {
        test('rejects when product is not owned by tenant', async () => {
            const pool = {
                request() {
                    return {
                        input() { return this; },
                        async query() {
                            return { recordset: [] };
                        }
                    };
                }
            };
            const result = await ensureOwnerTenantProductSubscription(
                pool,
                { UniqueIdentifier: 'guid' },
                'AE8A82A9-632D-4655-AEDA-7CB563D3A8C6',
                '22222222-2222-2222-2222-222222222222',
                'user-id'
            );
            expect(result.ok).toBe(false);
            expect(result.status).toBe(403);
        });
    });
});
