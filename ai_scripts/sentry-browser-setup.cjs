#!/usr/bin/env node
'use strict';

/**
 * Automate Sentry setup for OpenEnroll → Cursor pipeline.
 * - Creates personal auth token
 * - Creates/updates Internal Integration webhook
 * - Creates production issue alert rules for backend + frontend
 * - Writes SENTRY_AUTH_TOKEN + SENTRY_WEBHOOK_SECRET to backend/.env
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, 'backend/.env');
const ORG = 'mightywell-health';
const WEBHOOK_URL = 'https://api.allaboard365.com/api/webhooks/sentry';
const PROJECTS = ['backend', 'frontend'];

const EMAIL = process.env.SENTRY_SETUP_EMAIL || 'admin@mightywell.us';
const PASSWORD = process.env.SENTRY_SETUP_PASSWORD;
const EXISTING_WEBHOOK_SECRET = process.env.SENTRY_WEBHOOK_SECRET;

if (!PASSWORD) {
  console.error('Set SENTRY_SETUP_PASSWORD in the environment.');
  process.exit(1);
}

function upsertEnv(key, value) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
  fs.writeFileSync(ENV_FILE, text);
}

async function login(page) {
  await page.goto(`https://${ORG}.sentry.io/auth/login/`, { waitUntil: 'networkidle' });
  await page.fill('input[name="username"], input[placeholder*="email" i], input[placeholder*="username" i]', EMAIL);
  await page.fill('input[name="password"], input[type="password"]', PASSWORD);
  await page.click('button:has-text("Sign In")');
  await page.waitForURL(/sentry\.io/, { timeout: 60000 });
}

async function setPermission(page, label, value) {
  const row = page.locator('label, div').filter({ hasText: new RegExp(`^${label}$`) }).first();
  const container = row.locator('xpath=ancestor::*[.//input or .//button][1]');
  const input = container.locator('input').first();
  await input.click();
  await page.getByRole('menuitemradio', { name: value, exact: true }).click();
}

async function createAuthToken(page) {
  await page.goto(`https://${ORG}.sentry.io/settings/account/api/auth-tokens/new-token/`, { waitUntil: 'networkidle' });
  await page.fill('input[aria-label="Name"], label:has-text("Name") + input, input:near(:text("Name"))', 'OpenEnroll Cursor Setup');
  await setPermission(page, 'Project', 'Admin');
  await setPermission(page, 'Release', 'Admin');
  await setPermission(page, 'Organization', 'Read & Write');
  await setPermission(page, 'Alerts', 'Read & Write');
  await page.click('button:has-text("Create Token")');
  await page.waitForSelector('text=Your token');
  const token = await page.locator('input[readonly], code, pre').first().inputValue().catch(async () => {
    const text = await page.locator('body').innerText();
    const match = text.match(/sntrys_[A-Za-z0-9_\-]+/);
    return match ? match[0] : null;
  });
  if (!token) throw new Error('Could not extract Sentry auth token from UI');
  return token;
}

async function ensureInternalIntegration(page, authToken) {
  const listRes = await page.request.get(`https://sentry.io/api/0/organizations/${ORG}/sentry-apps/`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  const apps = await listRes.json();
  const existing = Array.isArray(apps) ? apps.find((a) => a.name === 'OpenEnroll Cursor Automation') : null;

  const payload = {
    name: 'OpenEnroll Cursor Automation',
    webhookUrl: WEBHOOK_URL,
    isAlertable: true,
    isInternal: true,
    verifyInstall: false,
    scopes: ['event:read', 'alerts:read'],
    events: ['issue'],
  };

  let app = existing;
  if (existing) {
    const updateRes = await page.request.put(`https://sentry.io/api/0/sentry-apps/${existing.slug}/`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      data: payload,
    });
    if (!updateRes.ok()) {
      const body = await updateRes.text();
      throw new Error(`Failed to update internal integration: ${updateRes.status()} ${body}`);
    }
    app = await updateRes.json();
  } else {
    const createRes = await page.request.post(`https://sentry.io/api/0/organizations/${ORG}/sentry-apps/`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      data: payload,
    });
    if (!createRes.ok()) {
      const body = await createRes.text();
      throw new Error(`Failed to create internal integration via API (${createRes.status()}). Will try UI. ${body}`);
    }
    app = await createRes.json();
  }

  let clientSecret = app.clientSecret;
  if (!clientSecret || clientSecret.includes('*')) {
    await page.goto(`https://${ORG}.sentry.io/settings/developer-settings/${app.slug}/`, { waitUntil: 'networkidle' });
    const secretText = await page.locator('text=Client Secret').locator('xpath=following::*[1]').innerText().catch(() => '');
    const match = secretText.match(/[a-f0-9]{64}/i);
    clientSecret = match ? match[0] : EXISTING_WEBHOOK_SECRET;
  }

  return { app, clientSecret };
}

async function createInternalIntegrationViaUI(page) {
  await page.goto(`https://${ORG}.sentry.io/settings/developer-settings/new-internal/`, { waitUntil: 'networkidle' });
  await page.fill('input[aria-label="Name"], label:has-text("Name") + input', 'OpenEnroll Cursor Automation');
  await page.fill('input[aria-label="Webhook URL"], label:has-text("Webhook URL") + input', WEBHOOK_URL);
  const alertToggle = page.locator('label:has-text("Alert Rule Action") input[type="checkbox"]');
  if (!(await alertToggle.isChecked())) await alertToggle.check();
  await setPermission(page, 'Issue & Event', 'Read');
  const issueWebhook = page.locator('label:has-text("issue") input[type="checkbox"]');
  if (await issueWebhook.isEnabled()) await issueWebhook.check();
  await page.click('button:has-text("Save Changes")');
  await page.waitForURL(/developer-settings\//);
  const slug = page.url().split('/').filter(Boolean).pop();
  const secretMatch = (await page.locator('body').innerText()).match(/Client Secret[\s\S]*?([a-f0-9]{64})/i);
  return { slug, clientSecret: secretMatch ? secretMatch[1] : EXISTING_WEBHOOK_SECRET };
}

async function getIntegrationInstallations(page, authToken) {
  const res = await page.request.get(`https://sentry.io/api/0/organizations/${ORG}/sentry-app-installations/`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return res.json();
}

async function ensureAlertRule(page, authToken, projectSlug, integrationSlug) {
  const rulesRes = await page.request.get(`https://sentry.io/api/0/projects/${ORG}/${projectSlug}/rules/`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  const rules = await rulesRes.json();
  const ruleName = `Cursor Automation - production issues (${projectSlug})`;
  if (Array.isArray(rules) && rules.some((r) => r.name === ruleName)) {
    console.log(`Alert rule already exists for ${projectSlug}`);
    return;
  }

  const body = {
    name: ruleName,
    actionMatch: 'all',
    filterMatch: 'all',
    frequency: 30,
    conditions: [{ id: 'sentry.rules.conditions.first_seen_event.FirstSeenEventCondition' }],
    filters: [
      {
        id: 'sentry.rules.filters.tagged_event.TaggedEventFilter',
        key: 'environment',
        match: 'eq',
        value: 'production',
      },
    ],
    actions: [
      {
        id: 'sentry.integrations.sentry_app.notify_action.SentryAppNotifyServiceAction',
        sentryAppInstallationUuid: integrationSlug,
        settings: [],
      },
    ],
  };

  const createRes = await page.request.post(`https://sentry.io/api/0/projects/${ORG}/${projectSlug}/rules/`, {
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
    data: body,
  });

  if (!createRes.ok()) {
    const err = await createRes.text();
    console.warn(`Could not create alert rule for ${projectSlug}: ${createRes.status()} ${err}`);
    return;
  }
  console.log(`Created alert rule for ${projectSlug}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Logging into Sentry...');
    await login(page);

    console.log('Creating auth token...');
    const authToken = await createAuthToken(page);
    upsertEnv('SENTRY_AUTH_TOKEN', authToken);
    upsertEnv('SENTRY_ORG', ORG);
    upsertEnv('SENTRY_PROJECT', 'frontend');
    console.log('Saved SENTRY_AUTH_TOKEN to backend/.env');

    let integration;
    try {
      console.log('Creating internal integration via API...');
      integration = await ensureInternalIntegration(page, authToken);
    } catch (err) {
      console.warn(err.message);
      console.log('Falling back to UI for internal integration...');
      const ui = await createInternalIntegrationViaUI(page);
      integration = { app: { slug: ui.slug }, clientSecret: ui.clientSecret };
    }

    if (integration.clientSecret) {
      upsertEnv('SENTRY_WEBHOOK_SECRET', integration.clientSecret);
      console.log('Updated SENTRY_WEBHOOK_SECRET in backend/.env');
    }

    const installations = await getIntegrationInstallations(page, authToken);
    const install = Array.isArray(installations)
      ? installations.find((i) => i.app?.slug?.includes('openenroll-cursor-automation') || i.app?.name === 'OpenEnroll Cursor Automation')
      : null;

    const installationUuid = install?.uuid || integration.app?.uuid;
    if (installationUuid) {
      for (const project of PROJECTS) {
        await ensureAlertRule(page, authToken, project, installationUuid);
      }
    } else {
      console.warn('Could not resolve integration installation UUID for alert rules.');
    }

    console.log('Sentry setup complete.');
    console.log(JSON.stringify({
      org: ORG,
      webhookUrl: WEBHOOK_URL,
      integrationSlug: integration.app?.slug,
      projects: PROJECTS,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
