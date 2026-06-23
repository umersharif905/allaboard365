const sql = require('mssql');
const {
  resolveFromEmailForTenant,
  platformDefaultFromEmail,
} = require('./tenantEmailFrom');

async function ensureConnected(pool) {
  if (!pool.connected) {
    await pool.connect();
  }
}

/**
 * Resolve the Send From for EMAIL using tenant AdvancedSettings + DEFAULT_FROM_EMAIL.
 */
async function resolveSendFromStrict(pool, tenantId, context) {
  await ensureConnected(pool);

  const res = await pool.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT Name, AdvancedSettings
      FROM oe.Tenants
      WHERE TenantId = @TenantId
    `);

  if (!res.recordset || res.recordset.length === 0) {
    throw new Error('Tenant not found for TenantId ' + tenantId);
  }

  const row = res.recordset[0];
  const fromName = row.Name && String(row.Name).trim() ? String(row.Name).trim() : 'AllAboard365';

  let fromEmail = platformDefaultFromEmail();
  if (row.AdvancedSettings) {
    try {
      const settings = JSON.parse(row.AdvancedSettings);
      fromEmail = resolveFromEmailForTenant(settings?.email);
      if (context && context.log) {
        if (fromEmail === platformDefaultFromEmail()) {
          context.log(
            'Using platform default from address: ' +
              fromEmail +
              ' (tenant email not configured or not verified)'
          );
        } else {
          context.log('Using tenant custom from address: ' + fromEmail);
        }
      }
    } catch (err) {
      if (context && context.log) context.log.warn('AdvancedSettings JSON parse failed: ' + err.message);
    }
  } else if (context && context.log) {
    context.log('Using platform default from address: ' + fromEmail);
  }

  const fromHeader = fromName + ' <' + fromEmail + '>';
  if (context && context.log) {
    context.log('Resolved FROM -> name="' + fromName + '" email="' + fromEmail + '" for tenant ' + tenantId);
  }
  return { fromHeader, fromName, fromEmail };
}

/**
 * Normalize a phone for Twilio (E.164): trim, strip spaces/dashes/parentheses/any non-digits, then + prefix.
 * Example: "(904) 555-1212" -> "+19045551212"
 */
function formatPhone(phone) {
  if (phone == null || phone === '') return phone;
  const s = String(phone).trim();
  if (!s) return '';
  let cleaned = s.replace(/\D/g, '');
  if (!cleaned) return '';
  if (cleaned.length === 10) cleaned = '1' + cleaned;
  if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;
  return cleaned;
}

async function resolveSmsFromStrict(pool, tenantId, context) {
  await ensureConnected(pool);

  const res = await pool.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT AdvancedSettings
      FROM oe.Tenants
      WHERE TenantId = @TenantId
    `);

  if (!res.recordset || res.recordset.length === 0) {
    throw new Error('Tenant not found for TenantId ' + tenantId);
  }

  const row = res.recordset[0];
  let fromPhone = null;

  if (row.AdvancedSettings) {
    try {
      const settings = JSON.parse(row.AdvancedSettings);
      const s = settings && settings.sms ? settings.sms : null;
      if (s && s.customFromPhone && String(s.customFromPhone).trim()) {
        fromPhone = formatPhone(String(s.customFromPhone).trim());
        if (context && context.log) {
          context.log('Using tenant custom SMS from number: ' + fromPhone);
        }
      }
    } catch (err) {
      if (context && context.log) context.log.warn('AdvancedSettings JSON parse failed: ' + err.message);
    }
  }

  if (!fromPhone) {
    fromPhone = process.env.TWILIO_PHONE_NUMBER ? formatPhone(process.env.TWILIO_PHONE_NUMBER) : null;
    if (context && context.log) {
      context.log('Using env TWILIO_PHONE_NUMBER for SMS from: ' + (fromPhone || 'NOT SET'));
    }
  }

  return fromPhone;
}

const NULL_RECIPIENT_SENTINEL = '00000000-0000-0000-0000-000000000000';

module.exports = {
  ensureConnected,
  resolveSendFromStrict,
  resolveSmsFromStrict,
  formatPhone,
  NULL_RECIPIENT_SENTINEL
};
