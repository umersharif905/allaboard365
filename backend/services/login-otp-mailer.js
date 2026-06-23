'use strict';

const axios = require('axios');
const { getTenantMessagingCredentials } = require('./tenant-messaging-credentials.service');
const { platformDefaultFromEmail } = require('../utils/tenantEmailFrom');

const SYNTHETIC_EMAIL_DOMAIN = '@noemail.com';

function isSyntheticEmail(email) {
  return !email || String(email).toLowerCase().endsWith(SYNTHETIC_EMAIL_DOMAIN);
}

function formatE164(phone) {
  if (phone == null || phone === '') return '';
  let cleaned = String(phone).replace(/\D/g, '');
  if (!cleaned) return '';
  if (cleaned.length === 10) cleaned = '1' + cleaned;
  if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;
  return cleaned;
}

function resolveSmsFrom(creds) {
  return (
    formatE164(creds.smsCustomFromPhone) ||
    formatE164(creds.twilioPhoneNumber) ||
    null
  );
}

function resolveFromEmail(creds) {
  const custom =
    creds.emailCustomFromAddress && String(creds.emailCustomFromAddress).trim();
  if (custom) return custom;
  return (
    (creds.defaultFromEmail && String(creds.defaultFromEmail).trim()) ||
    platformDefaultFromEmail()
  );
}

/**
 * @param {object} opts
 * @param {string} [opts.tenantId]
 * @param {object} [opts.messaging] - pre-resolved credentials
 * @param {string} opts.toPhone
 * @param {string} opts.code
 * @param {string} [opts.autofillDomain]
 */
async function sendLoginOtpSms({ tenantId, messaging, toPhone, code, autofillDomain }) {
  const creds = messaging || (await getTenantMessagingCredentials(tenantId));
  const sid = creds.twilioAccountSid;
  const token = creds.twilioAuthToken;
  const from = resolveSmsFrom(creds);
  if (!sid || !token || !from) {
    throw new Error('SMS is not configured for this tenant');
  }

  const to = formatE164(toPhone);
  const domain = (autofillDomain || process.env.LOGIN_OTP_SMS_DOMAIN || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .trim();
  // One-line SMS by default. Optional second line (@domain #code) only when LOGIN_OTP_SMS_DOMAIN
  // is set — helps iOS/Android autofill; not required for delivery.
  const body = domain
    ? `Your sign-in code is ${code}\n\n@${domain} #${code}`
    : `Your sign-in code is ${code}`;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams();
  params.append('To', to);
  params.append('From', from);
  params.append('Body', body);
  await axios.post(url, params.toString(), {
    auth: { username: sid, password: token },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000,
  });
}

/**
 * @param {object} opts
 * @param {string} [opts.tenantId]
 * @param {object} [opts.messaging]
 * @param {string} opts.toEmail
 * @param {string} opts.code
 * @param {string} [opts.tenantName]
 */
async function postSendGridMail(apiKey, payload) {
  await axios.post('https://api.sendgrid.com/v3/mail/send', payload, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
}

async function sendLoginOtpEmail({ tenantId, messaging, toEmail, code, tenantName = 'AllAboard365' }) {
  if (isSyntheticEmail(toEmail)) {
    throw new Error('No valid email on file');
  }

  const creds = messaging || (await getTenantMessagingCredentials(tenantId));
  // Platform key (same as MessageQueue immediate send); tenant key often lacks verified sender domain.
  const apiKey = process.env.SENDGRID_API_KEY || creds.sendgridApiKey;
  const customFrom = resolveFromEmail(creds);
  const defaultFrom = platformDefaultFromEmail();
  if (!apiKey) {
    throw new Error('Email is not configured for this tenant');
  }

  const subject = `${code} is your ${tenantName} sign-in code`;
  const html = `
    <p>Your sign-in code is: <strong>${code}</strong></p>
    <p>This code expires in 10 minutes. If you did not request this, you can ignore this email.</p>
  `;

  const buildPayload = (fromEmail) => ({
    personalizations: [{ to: [{ email: toEmail }] }],
    from: { email: fromEmail, name: tenantName },
    subject,
    content: [{ type: 'text/html', value: html }],
  });

  const fromCandidates = [
    ...(customFrom ? [customFrom] : []),
    defaultFrom,
  ].filter((v, i, arr) => v && arr.indexOf(v) === i);

  let lastErr;
  for (const fromEmail of fromCandidates) {
    try {
      await postSendGridMail(apiKey, buildPayload(fromEmail));
      if (fromEmail !== customFrom && customFrom) {
        console.warn(
          `[login-otp] Sent OTP email using fallback from ${fromEmail} (tenant custom from ${customFrom} was rejected or skipped)`
        );
      }
      return;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status === 403 && fromEmail !== defaultFrom) {
        console.warn(`[login-otp] SendGrid 403 for from ${fromEmail}, trying fallback`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('Email send failed');
}

module.exports = {
  sendLoginOtpEmail,
  sendLoginOtpSms,
  isSyntheticEmail,
  formatE164,
  resolveSmsFrom,
  resolveFromEmail,
};
