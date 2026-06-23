const {
    cancelTenantProductSubscription,
    listProductSubscribers
} = require('../tenantProductSubscriptionCancel.service');

describe('tenantProductSubscriptionCancel.service', () => {
    const tenantId = '11111111-1111-1111-1111-111111111111';
    const ownerTenantId = '22222222-2222-2222-2222-222222222222';
    const productId = '33333333-3333-3333-3333-333333333333';
    const subscriptionId = '44444444-4444-4444-4444-444444444444';
    const modifiedBy = '55555555-5555-5555-5555-555555555555';

    function makePool(handlers) {
        let call = 0;
        return {
            request() {
                const idx = call++;
                const handler = handlers[idx];
                return {
                    input() {
                        return this;
                    },
                    async query() {
                        return handler ? handler() : { recordset: [], rowsAffected: [0] };
                    }
                };
            }
        };
    }

    test('blocks unsubscribe when tenant is the product owner', async () => {
        const pool = makePool([
            () => ({
                recordset: [{
                    SubscriptionId: subscriptionId,
                    ProductId: productId,
                    TenantId: ownerTenantId,
                    ProductOwnerId: ownerTenantId
                }]
            })
        ]);

        const result = await cancelTenantProductSubscription(pool, {}, {
            tenantId: ownerTenantId,
            subscriptionId,
            modifiedBy
        });

        expect(result).toEqual({
            ok: false,
            status: 400,
            message: 'Cannot remove subscription for the product owner tenant'
        });
    });

    test('cancels tenant product subscription and marks ProductSubscriptions removed', async () => {
        const pool = makePool([
            () => ({
                recordset: [{
                    SubscriptionId: subscriptionId,
                    ProductId: productId,
                    TenantId: tenantId,
                    RequestId: null,
                    ProductOwnerId: ownerTenantId
                }]
            }),
            () => ({ rowsAffected: [1] }),
            () => ({ recordset: [{ ProductId: productId }] }),
            () => ({ rowsAffected: [1] })
        ]);

        const result = await cancelTenantProductSubscription(pool, {}, {
            tenantId,
            subscriptionId,
            modifiedBy
        });

        expect(result).toEqual({
            ok: true,
            tenantId,
            productId,
            subscriptionId
        });
    });

    test('cascades cancel to bundle included subscriptions sharing RequestId', async () => {
        const requestId = '66666666-6666-6666-6666-666666666666';
        const pool = makePool([
            () => ({
                recordset: [{
                    SubscriptionId: subscriptionId,
                    ProductId: productId,
                    TenantId: tenantId,
                    RequestId: requestId,
                    ProductOwnerId: ownerTenantId
                }]
            }),
            () => ({ rowsAffected: [3] }),
            () => ({ recordset: [{ ProductId: productId }, { ProductId: '77777777-7777-7777-7777-777777777777' }] }),
            () => ({ rowsAffected: [1] }),
            () => ({ rowsAffected: [1] })
        ]);

        const result = await cancelTenantProductSubscription(pool, {}, {
            tenantId,
            subscriptionId,
            modifiedBy
        });

        expect(result.ok).toBe(true);
    });

    test('listProductSubscribers maps owner flag', async () => {
        const pool = makePool([
            () => ({
                recordset: [{
                    SubscriptionId: subscriptionId,
                    TenantId: tenantId,
                    TenantName: 'Acme',
                    SubscriptionStatus: 'Active',
                    SubscriptionDate: '2026-01-01',
                    ProductOwnerId: ownerTenantId,
                    IsProductOwner: 0
                }]
            })
        ]);

        const result = await listProductSubscribers(pool, {}, productId);
        expect(result.ok).toBe(true);
        expect(result.subscribers).toEqual([{
            subscriptionId,
            tenantId,
            tenantName: 'Acme',
            subscriptionStatus: 'Active',
            subscriptionDate: '2026-01-01',
            isProductOwner: false
        }]);
    });
});
