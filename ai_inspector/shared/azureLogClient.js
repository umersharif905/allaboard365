/**
 * Azure Log Client
 *
 * Authenticates via Service Principal (client credentials) and pulls recent
 * application logs from every Web App and Function App in a resource group
 * using the App Insights Query API (Log Analytics).
 *
 * Each app service that has APPLICATIONINSIGHTS_CONNECTION_STRING set will
 * have its traces, exceptions, and requests queried for the last hour.
 */

const AZURE_AUTH_URL = 'https://login.microsoftonline.com';
const AZURE_MGMT_URL = 'https://management.azure.com';
const APPINSIGHTS_API_URL = 'https://api.applicationinsights.io/v1';
const MGMT_API_VERSION_SITES = '2023-12-01';

// ── Azure AD tokens ─────────────────────────────────────────────────────────

const _tokenCache = {};

async function getToken(scope) {
  const cached = _tokenCache[scope];
  if (cached && Date.now() < cached.expiry - 60_000) {
    return cached.token;
  }

  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET must be set');
  }

  const url = `${AZURE_AUTH_URL}/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Azure AD token request failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  _tokenCache[scope] = { token: json.access_token, expiry: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

async function getManagementToken() {
  return getToken(`${AZURE_MGMT_URL}/.default`);
}

async function getAppInsightsToken() {
  return getToken('https://api.applicationinsights.io/.default');
}

// ── Discover all sites + their App Insights AppId ───────────────────────────

async function listAllSites(log) {
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  const resourceGroup = process.env.RESOURCE_GROUP_NAME || 'AllAboard365';

  if (!subscriptionId) {
    throw new Error('AZURE_SUBSCRIPTION_ID must be set');
  }

  const token = await getManagementToken();

  // List all web/function apps
  const sitesUrl =
    `${AZURE_MGMT_URL}/subscriptions/${subscriptionId}` +
    `/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites` +
    `?api-version=${MGMT_API_VERSION_SITES}`;

  const sitesRes = await fetch(sitesUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!sitesRes.ok) {
    const text = await sitesRes.text();
    log(`Warning: failed to list sites (${sitesRes.status}): ${text}`);
    return [];
  }

  const sitesJson = await sitesRes.json();
  const sites = [];

  for (const site of sitesJson.value || []) {
    const name = site.name;

    // Get app settings to find App Insights connection string
    const settingsUrl =
      `${AZURE_MGMT_URL}${site.id}/config/appsettings/list` +
      `?api-version=${MGMT_API_VERSION_SITES}`;

    let appInsightsAppId = null;
    try {
      const settingsRes = await fetch(settingsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });

      if (settingsRes.ok) {
        const settingsJson = await settingsRes.json();
        const connString = settingsJson.properties?.APPLICATIONINSIGHTS_CONNECTION_STRING || '';
        const match = connString.match(/ApplicationId=([^;]+)/);
        if (match) {
          appInsightsAppId = match[1];
        }
      }
    } catch (err) {
      log(`${name}: failed to read app settings — ${err.message}`);
    }

    sites.push({
      name,
      kind: site.kind || 'app',
      appInsightsAppId,
    });
  }

  const withAI = sites.filter((s) => s.appInsightsAppId).length;
  log(`Discovered ${sites.length} site(s) in ${resourceGroup} (${withAI} with App Insights)`);
  return sites;
}

// ── Pull recent logs via App Insights Query API ─────────────────────────────

/**
 * Fetch recent logs for a site via its App Insights AppId.
 * Queries traces, exceptions, and failed requests from the last hour.
 *
 * Returns a string of formatted log text, or null if no AppId / no logs.
 */
async function fetchRecentLogs(siteName, log, appInsightsAppId) {
  if (!appInsightsAppId) {
    log(`${siteName}: no App Insights — skipping`);
    return null;
  }

  const token = await getAppInsightsToken();

  const query = `
    let timeRange = ago(1h);
    let traces_tbl = traces
      | where timestamp > timeRange
      | where severityLevel >= 2 or message has_any ("error", "fail", "exception", "warn", "timeout", "refused", "denied", "crash", "fatal", "unhandled")
      | project timestamp, itemType="trace", severity=severityLevel, message=substring(message, 0, 1000);
    let exceptions_tbl = exceptions
      | where timestamp > timeRange
      | project timestamp, itemType="exception", severity=4, message=strcat(type, ": ", outerMessage, " | ", substring(details, 0, 500));
    let requests_tbl = requests
      | where timestamp > timeRange
      | where success == false or resultCode !startswith "2"
      | project timestamp, itemType="request", severity=3, message=strcat(name, " -> HTTP ", resultCode, " (", round(duration, 1), "ms)");
    union traces_tbl, exceptions_tbl, requests_tbl
    | order by timestamp desc
    | take 500
  `;

  const url = `${APPINSIGHTS_API_URL}/apps/${appInsightsAppId}/query`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text();
      log(`${siteName}: App Insights query failed (${res.status}): ${text.slice(0, 200)}`);
      return null;
    }

    const json = await res.json();
    const table = json.tables?.[0];
    if (!table || !table.rows || table.rows.length === 0) {
      log(`${siteName}: no noteworthy logs in the last hour`);
      return null;
    }

    const colNames = table.columns.map((c) => c.name);
    const tsIdx = colNames.indexOf('timestamp');
    const typeIdx = colNames.indexOf('itemType');
    const sevIdx = colNames.indexOf('severity');
    const msgIdx = colNames.indexOf('message');

    const logLines = table.rows.map((row) => {
      const ts = row[tsIdx] ? row[tsIdx].slice(0, 19) : '';
      const type = row[typeIdx] || '';
      const sev = row[sevIdx] || '';
      const msg = row[msgIdx] || '';
      return `[${ts}] [${type}] [sev:${sev}] ${msg}`;
    });

    const logText = logLines.join('\n');
    log(`${siteName}: fetched ${table.rows.length} log entries from App Insights`);
    return logText;
  } catch (err) {
    log(`${siteName}: App Insights query error — ${err.message}`);
    return null;
  }
}

module.exports = {
  listAllSites,
  fetchRecentLogs,
};
