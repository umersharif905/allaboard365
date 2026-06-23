'use strict';

const VENDOR_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONN_ID   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID   = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ---- DB pool mock ----
let poolQueryResponses = [];
let poolQueryCallIndex = 0;
const mockPoolInput   = jest.fn().mockReturnThis();
const mockPoolQuery   = jest.fn().mockImplementation(() => {
  const r = poolQueryResponses[poolQueryCallIndex++] || { recordset: [] };
  return Promise.resolve(r);
});
const mockPoolRequest = jest.fn(() => ({ input: mockPoolInput, query: mockPoolQuery }));
const mockPool        = { request: mockPoolRequest };

jest.mock('../../config/database', () => ({
  getPool: jest.fn().mockResolvedValue(mockPool),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: jest.fn((n) => `NVarChar(${n || 'MAX'})`),
    Int: 'Int',
    Bit: 'Bit',
    MAX: 'MAX',
  },
}));

// ---- Encryption mock ----
jest.mock('../../services/encryptionService', () => ({
  encrypt: jest.fn((v) => `enc:${v}`),
  decrypt: jest.fn((v) => v.replace(/^enc:/, '')),
}));

// ---- SFTP client wrapper mock ----
const mockSftpConnect    = jest.fn().mockResolvedValue(undefined);
const mockSftpDisconnect = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/sftpClientWrapper', () => ({
  create: jest.fn(() => ({
    connect: mockSftpConnect,
    disconnect: mockSftpDisconnect,
  })),
}));

const encryptionService = require('../../services/encryptionService');

function setPoolResponses(...responses) {
  poolQueryCallIndex = 0;
  poolQueryResponses = responses;
}

function makeConnRow(overrides = {}) {
  return {
    ConnectionId: CONN_ID,
    VendorId: VENDOR_ID,
    DisplayName: 'Test SFTP',
    Host: 'sftp.example.com',
    Port: 22,
    Username: 'user',
    AuthType: 'password',
    PasswordEncrypted: 'enc:secret',
    PrivateKeyEncrypted: null,
    PassphraseEncrypted: null,
    BaseDirectory: null,
    IsActive: 1,
    CreatedBy: USER_ID,
    CreatedUtc: new Date(),
    ModifiedUtc: new Date(),
    ...overrides,
  };
}

let svc;
beforeAll(() => {
  svc = require('../../services/sftpConnectionService');
});

beforeEach(() => {
  jest.clearAllMocks();
  poolQueryCallIndex = 0;
  poolQueryResponses = [];
});

describe('createConnection', () => {
  test('encrypts password and returns sanitized row', async () => {
    setPoolResponses({ recordset: [makeConnRow()] });
    const result = await svc.createConnection({
      vendorId: VENDOR_ID,
      displayName: 'Test SFTP',
      host: 'sftp.example.com',
      port: 22,
      username: 'user',
      authType: 'password',
      password: 'secret',
      createdBy: USER_ID,
    });
    expect(encryptionService.encrypt).toHaveBeenCalledWith('secret');
    expect(result).not.toHaveProperty('PasswordEncrypted');
    expect(result).not.toHaveProperty('passwordEncrypted');
    expect(result.hasPassword).toBe(true);
    expect(result.connectionId).toBe(CONN_ID);
  });

  test('throws when required fields missing', async () => {
    await expect(svc.createConnection({ vendorId: VENDOR_ID }))
      .rejects.toThrow(/required/i);
  });
});

describe('getConnection', () => {
  test('returns sanitized row without encrypted fields', async () => {
    setPoolResponses({ recordset: [makeConnRow()] });
    const result = await svc.getConnection(CONN_ID, VENDOR_ID);
    expect(result).not.toHaveProperty('PasswordEncrypted');
    expect(result.hasPassword).toBe(true);
    expect(result.hasPrivateKey).toBe(false);
    expect(result.vendorId).toBe(VENDOR_ID);
  });

  test('returns null when not found', async () => {
    setPoolResponses({ recordset: [] });
    const result = await svc.getConnection(CONN_ID, VENDOR_ID);
    expect(result).toBeNull();
  });
});

describe('updateConnection', () => {
  test('preserves encrypted password when blank password provided', async () => {
    setPoolResponses({ recordset: [makeConnRow()] });
    // Empty/undefined password should NOT call encrypt
    await svc.updateConnection(CONN_ID, VENDOR_ID, { displayName: 'New Name', password: '' });
    expect(encryptionService.encrypt).not.toHaveBeenCalled();
  });

  test('replaces encrypted password when new password provided', async () => {
    setPoolResponses({ recordset: [makeConnRow()] });
    await svc.updateConnection(CONN_ID, VENDOR_ID, { password: 'newpass' });
    expect(encryptionService.encrypt).toHaveBeenCalledWith('newpass');
  });
});

describe('deleteConnection', () => {
  test('throws 409 when jobs reference the connection', async () => {
    setPoolResponses({ recordset: [{ RefCount: 2 }] });
    await expect(svc.deleteConnection(CONN_ID, VENDOR_ID)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  test('succeeds when no jobs reference the connection', async () => {
    setPoolResponses(
      { recordset: [{ RefCount: 0 }] }, // ref check
      { recordset: [] },                 // soft-delete
    );
    await expect(svc.deleteConnection(CONN_ID, VENDOR_ID)).resolves.toBeUndefined();
  });
});

describe('testConnection', () => {
  test('returns success and latencyMs on successful connect', async () => {
    setPoolResponses({ recordset: [makeConnRow()] });
    mockSftpConnect.mockResolvedValueOnce(undefined);
    const result = await svc.testConnection(CONN_ID, VENDOR_ID);
    expect(result.success).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  test('returns success=false and error message on connect failure', async () => {
    setPoolResponses({ recordset: [makeConnRow()] });
    mockSftpConnect.mockRejectedValueOnce(new Error('Connection refused'));
    const result = await svc.testConnection(CONN_ID, VENDOR_ID);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Connection refused/);
  });

  test('throws when connection not found (vendor mismatch)', async () => {
    setPoolResponses({ recordset: [] });
    await expect(svc.testConnection(CONN_ID, 'wrong-vendor-id'))
      .rejects.toThrow(/not found/i);
  });

  test('uses form overrides for host/username instead of saved row', async () => {
    setPoolResponses({ recordset: [makeConnRow()] });
    mockSftpConnect.mockResolvedValueOnce(undefined);
    await svc.testConnection(CONN_ID, VENDOR_ID, {
      host: 'new.sftp.example.com',
      username: 'newuser',
      password: 'newpass',
    });
    expect(mockSftpConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'new.sftp.example.com',
        username: 'newuser',
        password: 'newpass',
      })
    );
  });

  test('draft test without connectionId uses only overrides', async () => {
    mockSftpConnect.mockResolvedValueOnce(undefined);
    await svc.testConnection(null, VENDOR_ID, {
      host: 'draft.host.com',
      port: 2222,
      username: 'draftuser',
      authType: 'password',
      password: 'draftpass',
    });
    expect(mockPoolRequest).not.toHaveBeenCalled();
    expect(mockSftpConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'draft.host.com',
        port: 2222,
        username: 'draftuser',
        password: 'draftpass',
      })
    );
  });
});

describe('decryptConnectionCreds', () => {
  test('decrypts password and returns plaintext', async () => {
    setPoolResponses({ recordset: [makeConnRow()] });
    const creds = await svc.decryptConnectionCreds(CONN_ID, VENDOR_ID);
    expect(creds.password).toBe('secret');
    expect(creds).not.toHaveProperty('PasswordEncrypted');
  });
});
