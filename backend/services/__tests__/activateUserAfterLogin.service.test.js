'use strict';

const mockRequest = jest.fn(() => ({
  input: jest.fn().mockReturnThis(),
  query: jest.fn(),
}));

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => ({ request: mockRequest })),
  sql: { UniqueIdentifier: 'UniqueIdentifier' },
}));

const { activateUserAfterSuccessfulLogin } = require('../activateUserAfterLogin.service');

describe('activateUserAfterSuccessfulLogin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    let call = 0;
    mockRequest.mockImplementation(() => {
      const req = {
        input: jest.fn().mockReturnThis(),
        query: jest.fn(async () => {
          call += 1;
          if (call === 1) return { rowsAffected: [1] };
          if (call === 2) return { rowsAffected: [0] };
          if (call === 3) return { recordset: [{ ok: 1 }] };
          if (call === 4) return { rowsAffected: [0] };
          if (call === 5) return { rowsAffected: [2] };
          return { rowsAffected: [0], recordset: [] };
        }),
      };
      return req;
    });
  });

  it('activates pending user and members when enrollments exist', async () => {
    const result = await activateUserAfterSuccessfulLogin('00000000-0000-0000-0000-000000000001');
    expect(result.userActivated).toBe(true);
    expect(result.membersActivated).toBe(true);
    expect(mockRequest).toHaveBeenCalled();
  });
});
