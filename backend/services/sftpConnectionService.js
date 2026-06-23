'use strict';

const { getPool, sql } = require('../config/database');
const encryptionService = require('./encryptionService');
const sftpClientWrapper = require('./sftpClientWrapper');

/**
 * Strip encrypted fields and substitute has* booleans.
 * Never return PasswordEncrypted / PrivateKeyEncrypted / PassphraseEncrypted to callers.
 */
function sanitizeConnection(row) {
  if (!row) return null;
  return {
    connectionId: row.ConnectionId,
    vendorId: row.VendorId,
    displayName: row.DisplayName,
    host: row.Host,
    port: row.Port,
    username: row.Username,
    authType: row.AuthType,
    baseDirectory: row.BaseDirectory || null,
    isActive: row.IsActive,
    hasPassword: !!row.PasswordEncrypted,
    hasPrivateKey: !!row.PrivateKeyEncrypted,
    hasPassphrase: !!row.PassphraseEncrypted,
    createdBy: row.CreatedBy || null,
    createdUtc: row.CreatedUtc,
    modifiedUtc: row.ModifiedUtc,
  };
}

async function listConnections(vendorId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT ConnectionId, VendorId, DisplayName, Host, Port, Username, AuthType,
             BaseDirectory, IsActive,
             CASE WHEN PasswordEncrypted IS NOT NULL THEN 1 ELSE 0 END AS HasPassword,
             CASE WHEN PrivateKeyEncrypted IS NOT NULL THEN 1 ELSE 0 END AS HasPrivateKey,
             CASE WHEN PassphraseEncrypted IS NOT NULL THEN 1 ELSE 0 END AS HasPassphrase,
             CreatedBy, CreatedUtc, ModifiedUtc
      FROM oe.VendorSftpConnections
      WHERE VendorId = @vendorId AND IsActive = 1
      ORDER BY DisplayName
    `);
  return result.recordset.map((r) => ({
    connectionId: r.ConnectionId,
    vendorId: r.VendorId,
    displayName: r.DisplayName,
    host: r.Host,
    port: r.Port,
    username: r.Username,
    authType: r.AuthType,
    baseDirectory: r.BaseDirectory || null,
    isActive: r.IsActive,
    hasPassword: r.HasPassword === 1,
    hasPrivateKey: r.HasPrivateKey === 1,
    hasPassphrase: r.HasPassphrase === 1,
    createdBy: r.CreatedBy || null,
    createdUtc: r.CreatedUtc,
    modifiedUtc: r.ModifiedUtc,
  }));
}

async function getConnection(connectionId, vendorId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('connectionId', sql.UniqueIdentifier, connectionId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT ConnectionId, VendorId, DisplayName, Host, Port, Username, AuthType,
             PasswordEncrypted, PrivateKeyEncrypted, PassphraseEncrypted,
             BaseDirectory, IsActive, CreatedBy, CreatedUtc, ModifiedUtc
      FROM oe.VendorSftpConnections
      WHERE ConnectionId = @connectionId AND VendorId = @vendorId AND IsActive = 1
    `);
  const row = result.recordset?.[0];
  if (!row) return null;
  return sanitizeConnection(row);
}

/**
 * Internal: returns full row including encrypted columns for SFTP operations.
 * Do NOT export or return to API callers.
 */
async function _getConnectionWithCreds(connectionId, vendorId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('connectionId', sql.UniqueIdentifier, connectionId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT ConnectionId, VendorId, DisplayName, Host, Port, Username, AuthType,
             PasswordEncrypted, PrivateKeyEncrypted, PassphraseEncrypted,
             BaseDirectory, IsActive, CreatedBy, CreatedUtc, ModifiedUtc
      FROM oe.VendorSftpConnections
      WHERE ConnectionId = @connectionId AND VendorId = @vendorId AND IsActive = 1
    `);
  return result.recordset?.[0] || null;
}

/**
 * Decrypt credentials for internal SFTP use only.
 * Returns { password?, privateKey?, passphrase? } in plaintext.
 */
async function decryptConnectionCreds(connectionId, vendorId) {
  const row = await _getConnectionWithCreds(connectionId, vendorId);
  if (!row) throw new Error('Connection not found');
  const creds = {};
  if (row.PasswordEncrypted) {
    creds.password = encryptionService.decrypt(row.PasswordEncrypted);
  }
  if (row.PrivateKeyEncrypted) {
    creds.privateKey = encryptionService.decrypt(row.PrivateKeyEncrypted);
  }
  if (row.PassphraseEncrypted) {
    creds.passphrase = encryptionService.decrypt(row.PassphraseEncrypted);
  }
  return creds;
}

async function createConnection({ vendorId, displayName, host, port, username, authType, password, privateKey, passphrase, baseDirectory, createdBy }) {
  if (!displayName || !host || !username || !authType) {
    throw new Error('displayName, host, username, and authType are required');
  }

  const passwordEncrypted = password ? encryptionService.encrypt(String(password)) : null;
  const privateKeyEncrypted = privateKey ? encryptionService.encrypt(String(privateKey)) : null;
  const passphraseEncrypted = passphrase ? encryptionService.encrypt(String(passphrase)) : null;

  const pool = await getPool();
  const result = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('displayName', sql.NVarChar(150), displayName)
    .input('host', sql.NVarChar(255), host)
    .input('port', sql.Int, port || 22)
    .input('username', sql.NVarChar(150), username)
    .input('authType', sql.NVarChar(20), authType)
    .input('passwordEncrypted', sql.NVarChar(sql.MAX), passwordEncrypted)
    .input('privateKeyEncrypted', sql.NVarChar(sql.MAX), privateKeyEncrypted)
    .input('passphraseEncrypted', sql.NVarChar(sql.MAX), passphraseEncrypted)
    .input('baseDirectory', sql.NVarChar(500), baseDirectory || null)
    .input('createdBy', sql.UniqueIdentifier, createdBy || null)
    .query(`
      INSERT INTO oe.VendorSftpConnections
        (VendorId, DisplayName, Host, Port, Username, AuthType,
         PasswordEncrypted, PrivateKeyEncrypted, PassphraseEncrypted,
         BaseDirectory, IsActive, CreatedBy)
      OUTPUT INSERTED.*
      VALUES
        (@vendorId, @displayName, @host, @port, @username, @authType,
         @passwordEncrypted, @privateKeyEncrypted, @passphraseEncrypted,
         @baseDirectory, 1, @createdBy)
    `);
  return sanitizeConnection(result.recordset?.[0]);
}

async function updateConnection(connectionId, vendorId, { displayName, host, port, username, authType, password, privateKey, passphrase, baseDirectory }) {
  const pool = await getPool();
  const req = pool.request()
    .input('connectionId', sql.UniqueIdentifier, connectionId)
    .input('vendorId', sql.UniqueIdentifier, vendorId);

  const sets = ['ModifiedUtc = SYSUTCDATETIME()'];

  if (displayName !== undefined) {
    req.input('displayName', sql.NVarChar(150), displayName);
    sets.push('DisplayName = @displayName');
  }
  if (host !== undefined) {
    req.input('host', sql.NVarChar(255), host);
    sets.push('Host = @host');
  }
  if (port !== undefined) {
    req.input('port', sql.Int, port);
    sets.push('Port = @port');
  }
  if (username !== undefined) {
    req.input('username', sql.NVarChar(150), username);
    sets.push('Username = @username');
  }
  if (authType !== undefined) {
    req.input('authType', sql.NVarChar(20), authType);
    sets.push('AuthType = @authType');
  }
  if (baseDirectory !== undefined) {
    req.input('baseDirectory', sql.NVarChar(500), baseDirectory || null);
    sets.push('BaseDirectory = @baseDirectory');
  }

  // Blank credential on edit → preserve existing encrypted value (skip the column)
  if (password) {
    req.input('passwordEncrypted', sql.NVarChar(sql.MAX), encryptionService.encrypt(String(password)));
    sets.push('PasswordEncrypted = @passwordEncrypted');
  }
  if (privateKey) {
    req.input('privateKeyEncrypted', sql.NVarChar(sql.MAX), encryptionService.encrypt(String(privateKey)));
    sets.push('PrivateKeyEncrypted = @privateKeyEncrypted');
  }
  if (passphrase) {
    req.input('passphraseEncrypted', sql.NVarChar(sql.MAX), encryptionService.encrypt(String(passphrase)));
    sets.push('PassphraseEncrypted = @passphraseEncrypted');
  }

  const result = await req.query(`
    UPDATE oe.VendorSftpConnections
    SET ${sets.join(', ')}
    OUTPUT INSERTED.*
    WHERE ConnectionId = @connectionId AND VendorId = @vendorId AND IsActive = 1
  `);
  const row = result.recordset?.[0];
  if (!row) return null;
  return sanitizeConnection(row);
}

async function deleteConnection(connectionId, vendorId) {
  const pool = await getPool();

  // Check for active jobs referencing this connection
  const refCheck = await pool.request()
    .input('connectionId', sql.UniqueIdentifier, connectionId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT COUNT(*) AS RefCount
      FROM oe.VendorImportJobs
      WHERE ConnectionId = @connectionId AND VendorId = @vendorId
    `);
  const refCount = refCheck.recordset?.[0]?.RefCount || 0;
  if (refCount > 0) {
    const err = new Error(`Cannot delete: ${refCount} import job(s) reference this connection`);
    err.statusCode = 409;
    throw err;
  }

  // Soft-delete
  await pool.request()
    .input('connectionId', sql.UniqueIdentifier, connectionId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      UPDATE oe.VendorSftpConnections
      SET IsActive = 0, ModifiedUtc = SYSUTCDATETIME()
      WHERE ConnectionId = @connectionId AND VendorId = @vendorId
    `);
}

/**
 * Merge optional form overrides with a saved row (edit) or draft-only fields (create test).
 */
function resolveTestConnectParams(row, overrides = {}) {
  const authType = overrides.authType ?? row?.AuthType ?? 'password';
  const host = String(overrides.host ?? row?.Host ?? '').trim();
  const port = overrides.port ?? row?.Port ?? 22;
  const username = String(overrides.username ?? row?.Username ?? '').trim();

  if (!host || !username) {
    throw new Error('Host and username are required to test');
  }

  const creds = {};
  if (authType === 'password') {
    if (overrides.password) creds.password = overrides.password;
    else if (row?.PasswordEncrypted) creds.password = encryptionService.decrypt(row.PasswordEncrypted);
    if (!creds.password) throw new Error('Password is required to test connection');
  } else if (authType === 'privateKey') {
    if (overrides.privateKey) creds.privateKey = overrides.privateKey;
    else if (row?.PrivateKeyEncrypted) creds.privateKey = encryptionService.decrypt(row.PrivateKeyEncrypted);
    if (!creds.privateKey) throw new Error('Private key is required to test connection');
    if (overrides.passphrase) creds.passphrase = overrides.passphrase;
    else if (row?.PassphraseEncrypted) creds.passphrase = encryptionService.decrypt(row.PassphraseEncrypted);
  }

  return { host, port, username, ...creds };
}

async function runSftpConnectTest(connectParams) {
  const start = Date.now();
  const client = sftpClientWrapper.create();
  try {
    await client.connect(connectParams);
    const latencyMs = Date.now() - start;
    return { success: true, latencyMs };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/**
 * Test a connection without persisting anything.
 * When connectionId is set, loads saved row and merges overrides (blank password/key keeps stored secret).
 * When connectionId is null, tests draft credentials from overrides only.
 * Returns { success, latencyMs?, error? }.
 */
async function testConnection(connectionId, vendorId, overrides = {}) {
  let row = null;
  if (connectionId) {
    row = await _getConnectionWithCreds(connectionId, vendorId);
    if (!row) throw new Error('Connection not found');
  }

  const connectParams = resolveTestConnectParams(row, overrides);
  return runSftpConnectTest(connectParams);
}

module.exports = {
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  decryptConnectionCreds,
  _getConnectionWithCreds,
};
