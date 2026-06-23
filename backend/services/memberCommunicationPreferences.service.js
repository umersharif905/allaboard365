/**
 * Member marketing communication preferences (email/SMS opt-out).
 */
const { getPool, sql } = require('../config/database');

async function getPreferenceRow(pool, memberId) {
  const r = await pool.request()
    .input('MemberId', sql.UniqueIdentifier, memberId)
    .query(`
      SELECT PreferenceId, MemberId, TenantId, EmailMarketingOptOut, SmsMarketingOptOut,
             OptOutDate, OptOutSource, CreatedDate, ModifiedDate
      FROM oe.MemberCommunicationPreferences
      WHERE MemberId = @MemberId
    `);
  return r.recordset[0] || null;
}

async function insertConsentLog(pool, {
  memberId,
  tenantId,
  consentType,
  action,
  source,
  ipAddress = null,
  userAgent = null
}) {
  await pool.request()
    .input('MemberId', sql.UniqueIdentifier, memberId)
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .input('ConsentType', sql.NVarChar(50), consentType)
    .input('Action', sql.NVarChar(20), action)
    .input('Source', sql.NVarChar(100), source)
    .input('IpAddress', sql.NVarChar(50), ipAddress)
    .input('UserAgent', sql.NVarChar(500), userAgent)
    .query(`
      INSERT INTO oe.MemberConsentLog (MemberId, TenantId, ConsentType, Action, Source, IpAddress, UserAgent)
      VALUES (@MemberId, @TenantId, @ConsentType, @Action, @Source, @IpAddress, @UserAgent)
    `);
}

async function getPreferencesForMember(memberId) {
  const pool = await getPool();
  const row = await getPreferenceRow(pool, memberId);
  return {
    emailMarketingOptOut: !!(row && row.EmailMarketingOptOut),
    smsMarketingOptOut: !!(row && row.SmsMarketingOptOut)
  };
}

async function isEmailMarketingOptedOut(memberId) {
  const p = await getPreferencesForMember(memberId);
  return p.emailMarketingOptOut;
}

async function isSmsMarketingBlocked(memberId) {
  const pool = await getPool();
  const pref = await getPreferenceRow(pool, memberId);
  if (pref && pref.SmsMarketingOptOut) return true;
  const m = await pool.request()
    .input('MemberId', sql.UniqueIdentifier, memberId)
    .query(`SELECT SmsConsent FROM oe.Members WHERE MemberId = @MemberId`);
  if (!m.recordset.length) return true;
  const consent = m.recordset[0].SmsConsent;
  return !(consent === true || consent === 1);
}

async function updatePreferencesFromMemberPortal(memberId, tenantId, {
  emailMarketingEnabled,
  smsMarketingEnabled
}, { source = 'PreferenceCenter', ipAddress = null, userAgent = null } = {}) {
  const pool = await getPool();
  const existing = await getPreferenceRow(pool, memberId);

  const emailOptOut = !emailMarketingEnabled;
  const smsOptOut = !smsMarketingEnabled;

  if (!existing) {
    await pool.request()
      .input('MemberId', sql.UniqueIdentifier, memberId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .input('EmailMarketingOptOut', sql.Bit, emailOptOut ? 1 : 0)
      .input('SmsMarketingOptOut', sql.Bit, smsOptOut ? 1 : 0)
      .input('Source', sql.NVarChar(50), source)
      .query(`
        INSERT INTO oe.MemberCommunicationPreferences
          (MemberId, TenantId, EmailMarketingOptOut, SmsMarketingOptOut, OptOutDate, OptOutSource, ModifiedDate)
        VALUES (@MemberId, @TenantId, @EmailMarketingOptOut, @SmsMarketingOptOut,
                CASE WHEN @EmailMarketingOptOut = 1 OR @SmsMarketingOptOut = 1 THEN SYSUTCDATETIME() ELSE NULL END,
                CASE WHEN @EmailMarketingOptOut = 1 OR @SmsMarketingOptOut = 1 THEN @Source ELSE NULL END,
                SYSUTCDATETIME())
      `);
    await insertConsentLog(pool, {
      memberId,
      tenantId,
      consentType: 'EmailMarketing',
      action: emailOptOut ? 'OptOut' : 'OptIn',
      source,
      ipAddress,
      userAgent
    });
    await insertConsentLog(pool, {
      memberId,
      tenantId,
      consentType: 'SmsMarketing',
      action: smsOptOut ? 'OptOut' : 'OptIn',
      source,
      ipAddress,
      userAgent
    });
    return getPreferencesForMember(memberId);
  }

  const prevEmail = !!existing.EmailMarketingOptOut;
  const prevSms = !!existing.SmsMarketingOptOut;

  await pool.request()
    .input('MemberId', sql.UniqueIdentifier, memberId)
    .input('EmailMarketingOptOut', sql.Bit, emailOptOut ? 1 : 0)
    .input('SmsMarketingOptOut', sql.Bit, smsOptOut ? 1 : 0)
    .input('Source', sql.NVarChar(50), source)
    .query(`
      UPDATE oe.MemberCommunicationPreferences
      SET EmailMarketingOptOut = @EmailMarketingOptOut,
          SmsMarketingOptOut = @SmsMarketingOptOut,
          OptOutDate = CASE WHEN @EmailMarketingOptOut = 1 OR @SmsMarketingOptOut = 1 THEN ISNULL(OptOutDate, SYSUTCDATETIME()) ELSE NULL END,
          OptOutSource = CASE WHEN @EmailMarketingOptOut = 1 OR @SmsMarketingOptOut = 1 THEN @Source ELSE NULL END,
          ModifiedDate = SYSUTCDATETIME()
      WHERE MemberId = @MemberId
    `);

  if (prevEmail !== emailOptOut) {
    await insertConsentLog(pool, {
      memberId,
      tenantId,
      consentType: 'EmailMarketing',
      action: emailOptOut ? 'OptOut' : 'OptIn',
      source,
      ipAddress,
      userAgent
    });
  }
  if (prevSms !== smsOptOut) {
    await insertConsentLog(pool, {
      memberId,
      tenantId,
      consentType: 'SmsMarketing',
      action: smsOptOut ? 'OptOut' : 'OptIn',
      source,
      ipAddress,
      userAgent
    });
  }

  return getPreferencesForMember(memberId);
}

async function optOutEmailMarketingFromUnsubscribe(memberId, tenantId, source = 'UnsubscribeLink') {
  const pool = await getPool();
  const existing = await getPreferenceRow(pool, memberId);

  if (existing && existing.EmailMarketingOptOut) {
    return { alreadyOptedOut: true };
  }

  if (!existing) {
    // The token is valid but the member may have been deleted since it was issued.
    // Don't FK-crash the public endpoint — there's nothing (and nobody) to email anyway.
    const memberCheck = await pool.request()
      .input('MemberId', sql.UniqueIdentifier, memberId)
      .query(`SELECT 1 AS ok FROM oe.Members WHERE MemberId = @MemberId`);
    if (!memberCheck.recordset.length) {
      return { memberMissing: true };
    }
    await pool.request()
      .input('MemberId', sql.UniqueIdentifier, memberId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .input('Source', sql.NVarChar(50), source)
      .query(`
        INSERT INTO oe.MemberCommunicationPreferences
          (MemberId, TenantId, EmailMarketingOptOut, SmsMarketingOptOut, OptOutDate, OptOutSource, ModifiedDate)
        VALUES (@MemberId, @TenantId, 1, 0, SYSUTCDATETIME(), @Source, SYSUTCDATETIME())
      `);
  } else {
    await pool.request()
      .input('MemberId', sql.UniqueIdentifier, memberId)
      .input('Source', sql.NVarChar(50), source)
      .query(`
        UPDATE oe.MemberCommunicationPreferences
        SET EmailMarketingOptOut = 1,
            OptOutDate = SYSUTCDATETIME(),
            OptOutSource = @Source,
            ModifiedDate = SYSUTCDATETIME()
        WHERE MemberId = @MemberId
      `);
  }

  await insertConsentLog(pool, {
    memberId,
    tenantId,
    consentType: 'EmailMarketing',
    action: 'OptOut',
    source,
    ipAddress: null,
    userAgent: null
  });
  return { success: true };
}

async function optOutSmsMarketingFromStop(memberId, tenantId, source = 'STOP_keyword') {
  const pool = await getPool();
  const existing = await getPreferenceRow(pool, memberId);

  if (!existing) {
    await pool.request()
      .input('MemberId', sql.UniqueIdentifier, memberId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .input('Source', sql.NVarChar(50), source)
      .query(`
        INSERT INTO oe.MemberCommunicationPreferences
          (MemberId, TenantId, EmailMarketingOptOut, SmsMarketingOptOut, OptOutDate, OptOutSource, ModifiedDate)
        VALUES (@MemberId, @TenantId, 0, 1, SYSUTCDATETIME(), @Source, SYSUTCDATETIME())
      `);
    await insertConsentLog(pool, {
      memberId,
      tenantId,
      consentType: 'SmsMarketing',
      action: 'OptOut',
      source,
      ipAddress: null,
      userAgent: null
    });
    return;
  }

  if (existing.SmsMarketingOptOut) return;

  await pool.request()
    .input('MemberId', sql.UniqueIdentifier, memberId)
    .input('Source', sql.NVarChar(50), source)
    .query(`
      UPDATE oe.MemberCommunicationPreferences
      SET SmsMarketingOptOut = 1,
          OptOutDate = COALESCE(OptOutDate, SYSUTCDATETIME()),
          OptOutSource = @Source,
          ModifiedDate = SYSUTCDATETIME()
      WHERE MemberId = @MemberId
    `);

  await insertConsentLog(pool, {
    memberId,
    tenantId,
    consentType: 'SmsMarketing',
    action: 'OptOut',
    source,
    ipAddress: null,
    userAgent: null
  });
}

module.exports = {
  getPreferencesForMember,
  isEmailMarketingOptedOut,
  isSmsMarketingBlocked,
  updatePreferencesFromMemberPortal,
  optOutEmailMarketingFromUnsubscribe,
  optOutSmsMarketingFromStop,
  insertConsentLog
};
