const { resolveMessagingScope, ScopeError } = require('../messagingScope.service');

describe('resolveMessagingScope', () => {
  function makeMockPool(vendorIdValue) {
    const request = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({
        recordset: vendorIdValue === undefined ? [] : [{ VendorId: vendorIdValue }]
      })
    };
    return { request: jest.fn(() => request), _request: request };
  }

  it('returns vendorIdFilter from oe.Users for VendorAdmin', async () => {
    const pool = makeMockPool('vendor-uuid-1');
    const result = await resolveMessagingScope(
      { user: { UserId: 'user-1', userType: 'VendorAdmin', roles: ['VendorAdmin'] } },
      pool
    );
    expect(result).toEqual({ vendorIdFilter: 'vendor-uuid-1', isVendor: true });
    expect(pool._request.input).toHaveBeenCalledWith('userId', expect.anything(), 'user-1');
  });

  it('returns vendorIdFilter for VendorAgent', async () => {
    const pool = makeMockPool('vendor-uuid-2');
    const result = await resolveMessagingScope(
      { user: { UserId: 'user-2', userType: 'VendorAgent', roles: ['VendorAgent'] } },
      pool
    );
    expect(result).toEqual({ vendorIdFilter: 'vendor-uuid-2', isVendor: true });
  });

  it('returns null filter for TenantAdmin (no DB lookup)', async () => {
    const pool = makeMockPool();
    const result = await resolveMessagingScope(
      { user: { UserId: 'user-3', userType: 'TenantAdmin', roles: ['TenantAdmin'] } },
      pool
    );
    expect(result).toEqual({ vendorIdFilter: null, isVendor: false });
    expect(pool.request).not.toHaveBeenCalled();
  });

  it('returns null filter for SysAdmin', async () => {
    const pool = makeMockPool();
    const result = await resolveMessagingScope(
      { user: { UserId: 'user-4', userType: 'SysAdmin', roles: ['SysAdmin'] } },
      pool
    );
    expect(result).toEqual({ vendorIdFilter: null, isVendor: false });
  });

  it('throws ScopeError when vendor user has no VendorId on their oe.Users row', async () => {
    const pool = makeMockPool(); // empty recordset
    await expect(
      resolveMessagingScope(
        { user: { UserId: 'user-5', userType: 'VendorAdmin', roles: ['VendorAdmin'] } },
        pool
      )
    ).rejects.toBeInstanceOf(ScopeError);
  });
});
