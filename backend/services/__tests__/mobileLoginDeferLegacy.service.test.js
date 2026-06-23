'use strict';

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: { UniqueIdentifier: 'UniqueIdentifier' },
}));

const { getPool } = require('../../config/database');
const { userShouldDeferMobileLoginToLegacy } = require('../mobileLoginDeferLegacy.service');

describe('userShouldDeferMobileLoginToLegacy', () => {
  const userId = 'B020792B-2047-467F-844B-C8B24A10CDFD';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns true when primary member matches defer SQL', async () => {
    getPool.mockResolvedValue({
      request: () => ({
        input: jest.fn().mockReturnThis(),
        query: jest.fn().mockResolvedValue({ recordset: [{ ok: 1 }] }),
      }),
    });

    await expect(userShouldDeferMobileLoginToLegacy(userId)).resolves.toBe(true);
  });

  it('returns false when member has live AB365 go-live enrollment', async () => {
    getPool.mockResolvedValue({
      request: () => ({
        input: jest.fn().mockReturnThis(),
        query: jest.fn().mockResolvedValue({ recordset: [] }),
      }),
    });

    await expect(userShouldDeferMobileLoginToLegacy(userId)).resolves.toBe(false);
  });
});
